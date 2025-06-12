import Router from '@koa/router';
import { authenticator } from '../authenticator.js';
import { garminOauth } from '../garminOauth.js';
import { acceptValidator } from '../requestValidators.js';

export function attachPostGarminCourses(router: Router) {
  router.post(
    '/garmin-courses',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      const {
        name,
        description,
        activity,
        coordinates,
        distance,
        elevationGain,
        elevationLoss,
      } = ctx.request.body;

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
          geoPoints: coordinates.map(
            ([longitude, latitude, elevation]: [number, number, number?]) => ({
              latitude,
              longitude,
              elevation,
            }),
          ),
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

        ctx.log.error('Error sending course', responseText);

        ctx.throw(500);
      }

      ctx.status = 204;
    },
  );
}
