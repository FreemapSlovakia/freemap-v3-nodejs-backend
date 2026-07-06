import type { RouterInstance } from '@koa/router';
import z from 'zod';
import { authenticator } from '../authenticator.js';
import { garminOauth } from '../garminOauth.js';
import { AUTH_REQUIRED, registerPath } from '../openapi.js';
import { acceptValidator } from '../requestValidators.js';
import { resolveElevations } from './geotools/elevation.js';

const lon = z.number().min(-180).max(180);
const lat = z.number().min(-90).max(90);

const BodySchema = z.strictObject({
  name: z.string().optional(),
  description: z.string().optional(),
  activity: z.string().optional(),
  coordinates: z.array(
    z.union([z.tuple([lon, lat]), z.tuple([lon, lat, z.number()])]),
  ),
  distance: z.number(),
  elevationGain: z.number(),
  elevationLoss: z.number(),
  elapsedSeconds: z.number().optional(),
  speedMetersPerSecond: z.number().optional(),
});

export function attachPostGarminCourses(router: RouterInstance) {
  registerPath('/garmin-courses', {
    post: {
      summary: 'Export a route to Garmin Connect as a course',
      tags: ['tracking'],
      security: AUTH_REQUIRED,
      requestBody: { content: { 'application/json': { schema: BodySchema } } },
      responses: { 204: {}, 400: {}, 401: {}, 403: {} },
    },
  });

  router.post(
    '/garmin-courses',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      let body;

      try {
        body = BodySchema.parse(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      const {
        name,
        description,
        activity,
        coordinates,
        distance,
        elevationGain,
        elevationLoss,
        elapsedSeconds,
        speedMetersPerSecond,
      } = body;

      const url = 'https://apis.garmin.com/training-api/courses/v1/course';

      const user = ctx.state.user!;

      const { garminAccessToken, garminAccessTokenSecret } = user;

      if (!garminAccessToken || !garminAccessTokenSecret) {
        return ctx.throw(403);
      }

      const elevations: (number | null)[] = coordinates.map(
        (c) => c[2] ?? null,
      );

      // Garmin rejects a course where SOME — but not all — geo-points carry
      // elevation ("Elevation is missing for some of the geo-points"), yet a
      // course with no elevation at all is accepted. So when the route is
      // partially elevated we backfill the gaps from our own elevation service;
      // if that can't fully complete (a coverage gap, or the elevation service
      // being unavailable) we fall back to sending the course with no elevation
      // at all rather than failing the export.
      const missing: number[] = [];

      let hasElevation = false;

      for (const [i, e] of elevations.entries()) {
        if (e == null) {
          missing.push(i);
        } else {
          hasElevation = true;
        }
      }

      if (hasElevation && missing.length > 0) {
        const premium = Boolean(
          user.premiumExpiration && user.premiumExpiration > new Date(),
        );

        try {
          const filled = await resolveElevations(
            missing.map((i) => [coordinates[i][1], coordinates[i][0]]),
            premium,
            ctx.log,
          );

          for (const [k, i] of missing.entries()) {
            elevations[i] = filled[k];
          }
        } catch (err) {
          // The elevation service (GDAL local sources / SRTM tile downloads)
          // must never fail the export — leave the gaps unfilled; they are
          // stripped below so Garmin still accepts the course.
          ctx.log.warn({ err }, 'garmin course elevation backfill failed');
        }

        // If any point is still without elevation, sending the partial course
        // would be rejected; drop elevation from every point instead.
        if (elevations.some((e) => e == null)) {
          elevations.fill(null);
        }
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...garminOauth.toHeader(
            garminOauth.authorize(
              {
                url,
                method: 'POST',
              },
              {
                key: garminAccessToken,
                secret: garminAccessTokenSecret,
              },
            ),
          ),
        },
        body: JSON.stringify({
          courseName: name,
          description,
          distance, // in meters
          coordinateSystem: 'WGS84',
          elevationGain, // in meters
          elevationLoss, // in meters
          activityType: activity,
          elapsedSeconds,
          speedMetersPerSecond,
          geoPoints: coordinates.map(([longitude, latitude], i) => ({
            latitude,
            longitude,
            elevation: elevations[i] ?? undefined,
          })),
        }),
      });

      if (!response.ok) {
        const responseText = await response.text();

        let responseJson;

        try {
          responseJson = JSON.parse(responseText);
        } catch {
          responseJson = undefined;
        }

        if (responseJson?.error === 'PermissionsException') {
          ctx.throw(403, 'missing permission');
        }

        if (
          response.status === 401 &&
          responseJson?.message === 'OAuthToken is invalid'
        ) {
          ctx.throw(401, 'invalid oauth token');
        }

        // The backfill above already guarantees we never send a partially
        // elevated course, so this is defensive: if Garmin still complains
        // about missing elevation, treat it as a client-data problem and
        // surface a 4xx (filtered out of Sentry in instrument.ts). Any OTHER
        // 400 means our payload was malformed — let that bubble up as a 500 so
        // it stays visible in Sentry rather than being masked as a client error.
        if (
          response.status === 400 &&
          responseJson?.message ===
            'Elevation is missing for some of the geo-points'
        ) {
          ctx.throw(400, responseJson.message);
        }

        throw new Error('Error sending course: ' + responseText);
      }

      ctx.status = 204;
    },
  );
}
