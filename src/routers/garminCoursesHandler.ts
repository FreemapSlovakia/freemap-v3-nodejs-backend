import { RouterInstance } from '@koa/router';
import z from 'zod';
import { authenticator } from '../authenticator.js';
import { garminOauth } from '../garminOauth.js';
import { registerPath } from '../openapi.js';
import { acceptValidator } from '../requestValidators.js';

const BodySchema = z.strictObject({
  name: z.string().optional(),
  description: z.string().optional(),
  activity: z.string().optional(),
  coordinates: z.array(
    z.union([
      z.tuple([z.number(), z.number()]),
      z.tuple([z.number(), z.number(), z.number()]),
    ]),
  ),
  distance: z.number(),
  elevationGain: z.number(),
  elevationLoss: z.number(),
});

export function attachPostGarminCourses(router: RouterInstance) {
  registerPath('/garmin-courses', {
    post: {
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
      } = body;

      const url = 'https://apis.garmin.com/training-api/courses/v1/course';

      const { garminAccessToken, garminAccessTokenSecret } = ctx.state.user!;

      if (!garminAccessToken || !garminAccessTokenSecret) {
        return ctx.throw(403);
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
          geoPoints: coordinates.map(([longitude, latitude, elevation]) => ({
            latitude,
            longitude,
            elevation,
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

        throw new Error('Error sending course: ' + responseText);
      }

      ctx.status = 204;
    },
  );
}
