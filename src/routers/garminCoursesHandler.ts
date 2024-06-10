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
                key: ctx.state.user.garminAccessToken,
                secret: ctx.state.user.garminAccessTokenSecret,
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
        ctx.log.error('Error sending course', await response.text());
        ctx.throw(500);
      }

      ctx.status = 204;
    },
  );
}
