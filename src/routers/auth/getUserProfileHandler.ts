import type { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { pool } from '../../database.js';
import { registerPath } from '../../openapi.js';
import { providerProfile } from '../../providerProfiles.js';
import { acceptValidator } from '../../requestValidators.js';
import { RoleSchema } from '../../roles.js';
import { idParam } from '../../routeParams.js';
import {
  knownValues,
  type PublicField,
  PublicFieldSchema,
  zDateToIso,
} from '../../types.js';
import { redirectMergedUser } from '../../userAlias.js';

const ProfileDbSchema = z.object({
  id: z.uint32(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: zDateToIso,
  hasPicture: z.coerce.boolean(),
  premium: z.coerce.boolean(),
  // A stale value is dropped rather than failing a public endpoint.
  roles: knownValues(RoleSchema),
  publicFields: knownValues(PublicFieldSchema),
  email: z.string().nullable(),
  osmId: z.uint32().nullable(),
  githubUserId: z.string().nullable(),
  stravaUserId: z.string().nullable(),
  pictureCount: z.coerce.number(),
  commentCount: z.coerce.number(),
  eventCount: z.coerce.number(),
  countryCount: z.coerce.number(),
  viewCount: z.coerce.number(),
  ratingsGiven: z.coerce.number(),
});

const RanksDbSchema = z
  .array(
    z.object({
      pictureCount: z.coerce.number(),
      count90: z.coerce.number(),
      count30: z.coerce.number(),
      rankAll: z.coerce.number(),
      rank90: z.coerce.number(),
      rank30: z.coerce.number(),
    }),
  )
  .max(1);

const PerCountryDbSchema = z.array(
  z.object({
    country: z.string(),
    pictureCount: z.coerce.number(),
    count90: z.coerce.number(),
    count30: z.coerce.number(),
    rankAll: z.coerce.number(),
    rank90: z.coerce.number(),
    rank30: z.coerce.number(),
  }),
);

const ReceivedRatingDbSchema = z.object({
  count: z.coerce.number(),
  average: z.coerce.number().nullable(),
});

const PeriodRankingSchema = z.object({
  pictureCount: z.uint32(),
  rank: z
    .uint32()
    .nullable()
    .meta({ description: 'null when the user uploaded none in the period' }),
  /** Countries where the user ranks 1st to 3rd. */
  podiums: z.array(
    z.object({ country: z.string(), rank: z.int().min(1).max(3) }),
  ),
});

const ProfileSchema = z
  .object({
    id: z.uint32(),
    name: z.string(),
    description: z.string().nullable(),
    createdAt: z.iso.datetime(),
    hasPicture: z.boolean(),
    premium: z.boolean(),
    roles: z.array(RoleSchema),
    // Only what the user published (`publicFields`); a link whose provider
    // couldn't name the profile is left out.
    email: z.string().nullable(),
    links: z.array(
      z.object({
        provider: z.enum(['osm', 'github', 'strava']),
        url: z.url(),
        name: z.string(),
      }),
    ),
    gallery: z.object({
      pictureCount: z.uint32(),
      /** Comments the user wrote. */
      commentCount: z.uint32(),
      /** By picture count uploaded in the period, ranked like `/gallery/stats`. */
      ranking: z.object({
        all: PeriodRankingSchema,
        last90days: PeriodRankingSchema,
        last30days: PeriodRankingSchema,
      }),
      countryCount: z.uint32(),
      viewCount: z.uint32(),
      /** Ratings of the user's pictures by others. */
      receivedRating: z.object({
        count: z.uint32(),
        average: z.number().nullable(),
      }),
      /** Ratings the user gave, Wikimedia pictures included. */
      ratingsGiven: z.uint32(),
    }),
    /** Public events the user organizes. */
    eventCount: z.uint32(),
    /** Only with a published OSM link. */
    osm: z
      .object({
        mapperSince: z.iso.datetime(),
        changesetCount: z.uint32(),
        traceCount: z.uint32(),
        lastEditAt: z.iso.datetime().nullable(),
      })
      .nullable(),
  })
  .meta({ id: 'UserProfile' });

export function attachGetUserProfileHandler(router: RouterInstance) {
  registerPath('/auth/users/{id}/profile', {
    get: {
      summary: "Get a user's public profile",
      tags: ['auth'],
      requestParams: {
        path: z.object({
          id: z.uint32(),
        }),
      },
      responses: {
        200: {
          content: { 'application/json': { schema: ProfileSchema } },
        },
        302: { description: 'The user was merged into another one' },
        404: { description: 'no such user' },
      },
    },
  });

  router.get(
    '/users/:id/profile',
    acceptValidator('application/json'),
    async (ctx) => {
      const id = idParam(ctx, 'no such user');

      const [row] = await pool.query<unknown[]>(
        sql`SELECT
            id,
            name,
            description,
            createdAt,
            picture IS NOT NULL AS hasPicture,
            (premiumExpiration IS NOT NULL AND premiumExpiration > NOW()) AS premium,
            roles,
            publicFields,
            -- Only one its owner has proven is ever shown.
            mailableEmail AS email,
            osmId,
            githubUserId,
            stravaUserId,
            (SELECT COUNT(*) FROM picture WHERE userId = ${id}) AS pictureCount,
            (SELECT COUNT(*) FROM pictureComment WHERE userId = ${id})
              + (SELECT COUNT(*) FROM wikimediaComment WHERE userId = ${id})
              AS commentCount,
            (SELECT COUNT(*) FROM event WHERE userId = ${id})
              AS eventCount,
            (SELECT COUNT(DISTINCT country) FROM picture WHERE userId = ${id})
              AS countryCount,
            (SELECT COALESCE(SUM(viewCount), 0) FROM picture WHERE userId = ${id})
              AS viewCount,
            (SELECT COUNT(*) FROM pictureRating WHERE userId = ${id})
              + (SELECT COUNT(*) FROM wikimediaRating WHERE userId = ${id})
              AS ratingsGiven
          FROM user
          WHERE id = ${id}`,
      );

      if (!row) {
        if (await redirectMergedUser(ctx, id)) {
          return;
        }

        return ctx.throw(404, 'no such user');
      }

      const p = ProfileDbSchema.parse(row);

      const published = (field: PublicField) => p.publicFields.includes(field);

      const hasPictures = p.pictureCount > 0;

      // TODO: both ranking queries scan the whole picture table per profile
      // open; cache the ranked tables briefly if that starts to show.
      const [osm, github, [ranks], perCountry, receivedRating] =
        await Promise.all([
          published('osm') && p.osmId !== null
            ? providerProfile('osm', String(p.osmId))
            : null,
          published('github') && p.githubUserId !== null
            ? providerProfile('github', p.githubUserId)
            : null,
          hasPictures
            ? pool
                .query<unknown>(
                  sql`WITH
                    per_user AS (
                      SELECT
                        userId,
                        COUNT(*) AS pictureCount,
                        SUM(createdAt > DATE_SUB(NOW(), INTERVAL 90 DAY)) AS count90,
                        SUM(createdAt > DATE_SUB(NOW(), INTERVAL 30 DAY)) AS count30
                      FROM picture
                      GROUP BY userId
                    ),
                    ranked AS (
                      SELECT
                        *,
                        DENSE_RANK() OVER (ORDER BY pictureCount DESC) AS rankAll,
                        DENSE_RANK() OVER (ORDER BY count90 DESC) AS rank90,
                        DENSE_RANK() OVER (ORDER BY count30 DESC) AS rank30
                      FROM per_user
                    )
                  SELECT pictureCount, count90, count30, rankAll, rank90, rank30
                  FROM ranked
                  WHERE userId = ${id}`,
                )
                .then((rows) => RanksDbSchema.parse(rows))
            : [],
          hasPictures
            ? pool
                .query<unknown>(
                  sql`WITH
                    per_country_user AS (
                      SELECT
                        country,
                        userId,
                        COUNT(*) AS pictureCount,
                        SUM(createdAt > DATE_SUB(NOW(), INTERVAL 90 DAY)) AS count90,
                        SUM(createdAt > DATE_SUB(NOW(), INTERVAL 30 DAY)) AS count30
                      FROM picture
                      WHERE country IS NOT NULL
                      GROUP BY country, userId
                    ),
                    ranked AS (
                      SELECT
                        *,
                        DENSE_RANK() OVER (
                          PARTITION BY country ORDER BY pictureCount DESC
                        ) AS rankAll,
                        DENSE_RANK() OVER (
                          PARTITION BY country ORDER BY count90 DESC
                        ) AS rank90,
                        DENSE_RANK() OVER (
                          PARTITION BY country ORDER BY count30 DESC
                        ) AS rank30
                      FROM per_country_user
                    )
                  SELECT country, pictureCount, count90, count30, rankAll, rank90, rank30
                  FROM ranked
                  WHERE userId = ${id}
                  ORDER BY country`,
                )
                .then((rows) => PerCountryDbSchema.parse(rows))
            : [],
          hasPictures
            ? pool
                .query<unknown[]>(
                  sql`SELECT COUNT(*) AS count, AVG(stars) AS average
                  FROM pictureRating
                  JOIN picture ON picture.id = pictureRating.pictureId
                  WHERE picture.userId = ${id}
                    AND pictureRating.userId <> ${id}`,
                )
                .then(([row]) => ReceivedRatingDbSchema.parse(row))
            : { count: 0, average: null },
        ]);

      type Ranked = Partial<z.infer<typeof RanksDbSchema>[number]>;

      // A user without pictures in the period ties with all others at the
      // bottom, so a rank counts only with a count.
      const period = (
        count: (r: Ranked) => number | undefined,
        rank: (r: Ranked) => number | undefined,
      ) => {
        const pictureCount = count(ranks ?? {}) ?? 0;

        return {
          pictureCount,
          rank: pictureCount ? (rank(ranks ?? {}) ?? null) : null,
          podiums: perCountry
            .filter((c) => count(c) && rank(c)! <= 3)
            .toSorted((a, b) => rank(a)! - rank(b)! || count(b)! - count(a)!)
            .map((c) => ({ country: c.country, rank: rank(c)! })),
        };
      };

      const strava =
        published('strava') && p.stravaUserId !== null
          ? {
              url: `https://www.strava.com/athletes/${p.stravaUserId}`,
              // Strava's own name for the athlete needs its API token.
              name: `strava.com/athletes/${p.stravaUserId}`,
            }
          : null;

      ctx.body = ProfileSchema.parse({
        id: p.id,
        name: p.name,
        description: p.description,
        createdAt: p.createdAt,
        hasPicture: p.hasPicture,
        premium: p.premium,
        roles: p.roles,
        email: published('email') ? p.email : null,
        links: (
          [
            ['osm', osm],
            ['github', github],
            ['strava', strava],
          ] as const
        ).flatMap(([provider, link]) => (link ? [{ provider, ...link }] : [])),
        gallery: {
          pictureCount: p.pictureCount,
          commentCount: p.commentCount,
          ranking: {
            all: period(
              (r) => r.pictureCount,
              (r) => r.rankAll,
            ),
            last90days: period(
              (r) => r.count90,
              (r) => r.rank90,
            ),
            last30days: period(
              (r) => r.count30,
              (r) => r.rank30,
            ),
          },
          countryCount: p.countryCount,
          viewCount: p.viewCount,
          receivedRating,
          ratingsGiven: p.ratingsGiven,
        },
        eventCount: p.eventCount,
        osm: osm?.osm ?? null,
      });
    },
  );
}
