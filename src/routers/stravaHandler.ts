import type { RouterInstance } from '@koa/router';
import got from 'got';
import z from 'zod';
import { authenticator } from '../authenticator.js';
import { AUTH_REQUIRED, registerPath } from '../openapi.js';
import {
  getValidStravaAccessToken,
  STRAVA_API_BASE,
  StravaNotConnectedError,
} from '../strava.js';

// Curated subset of a Strava summary activity, enough to render a picker.
const ActivitySchema = z.object({
  id: z.number(),
  name: z.string(),
  sport_type: z.string().nullish(),
  distance: z.number().nullish(),
  moving_time: z.number().nullish(),
  elapsed_time: z.number().nullish(),
  total_elevation_gain: z.number().nullish(),
  start_date: z.string().nullish(),
  start_latlng: z.array(z.number()).nullish(),
  map: z.object({ summary_polyline: z.string().nullish() }).nullish(),
});

const ListResponseSchema = z.array(ActivitySchema);

const ActivityDetailSchema = z.object({
  name: z.string(),
  start_date: z.string(),
});

const NumberStream = z
  .object({ data: z.array(z.number().nullable()) })
  .nullish();

const StreamSetSchema = z.object({
  latlng: z.object({ data: z.array(z.tuple([z.number(), z.number()])) }),
  altitude: NumberStream,
  time: NumberStream,
  heartrate: NumberStream,
  cadence: NumberStream,
  watts: NumberStream,
  temp: NumberStream,
});

// Number rounded to at most 3 decimals, or '' when there is no value. Strava
// pads streams with `null` where a sensor dropped out.
function num(v: number | null | undefined): string {
  return v == null ? '' : String(Math.round(v * 1000) / 1000);
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function attachStravaHandlers(router: RouterInstance) {
  registerPath('/strava/activities', {
    get: {
      summary: "List the authenticated athlete's Strava activities",
      tags: ['strava'],
      security: AUTH_REQUIRED,
      requestParams: {
        query: z.object({
          page: z.coerce.number().int().positive().optional(),
          perPage: z.coerce.number().int().positive().max(200).optional(),
        }),
      },
      responses: {
        200: {
          content: { 'application/json': { schema: ListResponseSchema } },
        },
        401: {},
        403: {},
      },
    },
  });

  router.get('/strava/activities', authenticator(true), async (ctx) => {
    let accessToken;

    try {
      accessToken = await getValidStravaAccessToken(ctx.state.user!);
    } catch (err) {
      if (err instanceof StravaNotConnectedError) {
        return ctx.throw(403, 'strava not connected');
      }

      throw err;
    }

    const page = Array.isArray(ctx.query.page)
      ? ctx.query.page[0]
      : ctx.query.page;

    const perPage = Array.isArray(ctx.query.perPage)
      ? ctx.query.perPage[0]
      : ctx.query.perPage;

    ctx.body = ListResponseSchema.parse(
      await got
        .get(`${STRAVA_API_BASE}/athlete/activities`, {
          headers: { authorization: `Bearer ${accessToken}` },
          searchParams: {
            page: page ?? 1,
            per_page: Math.min(Number(perPage) || 30, 200),
          },
        })
        .json(),
    );
  });

  registerPath('/strava/activities/{id}/export', {
    get: {
      summary: 'Export a Strava activity as a GPX track',
      tags: ['strava'],
      security: AUTH_REQUIRED,
      requestParams: { path: z.object({ id: z.coerce.number().int() }) },
      responses: { 200: {}, 401: {}, 403: {}, 404: {} },
    },
  });

  router.get(
    '/strava/activities/:id/export',
    authenticator(true),
    async (ctx) => {
      let accessToken;

      try {
        accessToken = await getValidStravaAccessToken(ctx.state.user!);
      } catch (err) {
        if (err instanceof StravaNotConnectedError) {
          return ctx.throw(403, 'strava not connected');
        }

        throw err;
      }

      const id = ctx.params.id;

      const headers = { authorization: `Bearer ${accessToken}` };

      const [detail, streams] = await Promise.all([
        ActivityDetailSchema.parse(
          await got
            .get(`${STRAVA_API_BASE}/activities/${id}`, { headers })
            .json(),
        ),
        StreamSetSchema.parse(
          await got
            .get(`${STRAVA_API_BASE}/activities/${id}/streams`, {
              headers,
              searchParams: {
                keys: 'latlng,altitude,time,heartrate,cadence,watts,temp',
                key_by_type: 'true',
              },
            })
            .json(),
        ),
      ]);

      const latlng = streams.latlng.data;
      const altitude = streams.altitude?.data;
      const time = streams.time?.data;
      const heartrate = streams.heartrate?.data;
      const cadence = streams.cadence?.data;
      const watts = streams.watts?.data;
      const temp = streams.temp?.data;
      const startMs = new Date(detail.start_date).getTime();

      const points = latlng
        .map(([lat, lon], i) => {
          const ele = num(altitude?.[i]);
          const t = time?.[i];
          const hr = num(heartrate?.[i]);
          const cad = num(cadence?.[i]);
          const pwr = num(watts?.[i]);
          const atemp = num(temp?.[i]);

          // `gpxtpx:*` and `<power>` are the canonical Garmin/Strava
          // TrackPointExtension tags that the track viewer's colorizers read.
          const tpx =
            hr || cad || atemp
              ? `<gpxtpx:TrackPointExtension>${hr && `<gpxtpx:hr>${hr}</gpxtpx:hr>`}${cad && `<gpxtpx:cad>${cad}</gpxtpx:cad>`}${atemp && `<gpxtpx:atemp>${atemp}</gpxtpx:atemp>`}</gpxtpx:TrackPointExtension>`
              : '';

          const extensions =
            pwr || tpx
              ? `<extensions>${pwr && `<power>${pwr}</power>`}${tpx}</extensions>`
              : '';

          return (
            `<trkpt lat="${lat}" lon="${lon}">` +
            (ele && `<ele>${ele}</ele>`) +
            (t == null
              ? ''
              : `<time>${new Date(startMs + t * 1000).toISOString()}</time>`) +
            extensions +
            `</trkpt>`
          );
        })
        .join('');

      ctx.type = 'application/gpx+xml';

      ctx.body =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<gpx version="1.1" creator="Freemap" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">` +
        `<trk><name>${xmlEscape(detail.name)}</name><trkseg>${points}</trkseg></trk>` +
        `</gpx>`;
    },
  );
}
