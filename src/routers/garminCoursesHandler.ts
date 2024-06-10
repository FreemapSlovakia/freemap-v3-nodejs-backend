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
      const { name, description, activity, coordinates } = ctx.request.body;

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
          distance: 10000, // in meters
          duration: 3600, // in seconds
          coordinateSystem: 'WGS84',
          elevationGain: 200, // in meters
          elevationLoss: 200, // in meters
          activityType: activity,
          geoPoints: coordinates.map(
            ([longitude, latitude]: [number, number]) => ({
              latitude,
              longitude,
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
