import { RouterInstance } from '@koa/router';
import sql, { empty } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';

const UserSchema = z.object({
  id: z.uint32(),
  name: z.string(),
  hasPicture: z.boolean(),
  premium: z.boolean(),
});

const UserDbSchema = z.object({
  userId: z.uint32(),
  userName: z.string(),
  userHasPicture: z.coerce.boolean(),
  userPremium: z.coerce.boolean(),
});

const UsersPerCountryDbSchema = z
  .object({
    ...UserDbSchema.shape,
    pictureCount: z.uint32(),
    country: z.string().nonempty(),
  })
  .array();

const PerUserDbSchema = z
  .object({
    ...UserDbSchema.shape,
    pictureCount: z.uint32(),
  })
  .array();

const MePerCountryDbSchema = z
  .object({
    country: z.string().nonempty(),
    pictureCount: z.uint32(),
    userRank: z.number(),
  })
  .array();

const MeDbSchema = z
  .array(
    z.object({
      pictureCount: z.uint32(),
      userRank: z.number(),
    }),
  )
  .max(1);

const PerUserPerCountrySchema = z.record(
  z.string(),
  z
    .object({
      user: UserSchema,
      pictureCount: z.uint32(),
    })
    .array(),
);

const StatsSchema = z.strictObject({
  perUserPerCountry: PerUserPerCountrySchema,
  perUser: z
    .object({
      user: UserSchema,
      pictureCount: z.uint32(),
    })
    .array(),
  me: z
    .strictObject({
      perCountry: z
        .record(
          z.string(),
          z.strictObject({
            pictureCount: z.uint32(),
            userRank: z.uint32(),
          }),
        )
        .optional(),
      pictureCount: z.uint32(),
      userRank: z.uint32(),
    })
    .optional(),
});

type Stats = z.infer<typeof StatsSchema>;

export async function attachGetStatsHandler(router: RouterInstance) {
  registerPath('/gallery/stats', {
    get: {
      summary: 'Get gallery statistics',
      tags: ['gallery'],
      security: AUTH_OPTIONAL,
      responses: {
        200: {
          content: { 'application/json': { schema: StatsSchema } },
        },
      },
    },
  });

  router.get(
    '/stats',
    authenticator(false),
    acceptValidator('application/json'),
    async (ctx) => {
      const period = ctx.query['period'];

      const days = isNaN(Number(period || 'x'))
        ? empty
        : sql` AND picture.createdAt > DATE_SUB(NOW(), INTERVAL ${Number(period)} DAY)`;

      const usersPerCountry = UsersPerCountryDbSchema.parse(
        await pool.query<unknown>(sql`
          WITH
            per_country_user AS (
              SELECT
                country,
                userId,
                COUNT(*) AS pictureCount
              FROM picture
              WHERE country IS NOT NULL ${days}
              GROUP BY country, userId
            ),
            per_country AS (
              SELECT
                country,
                COUNT(*) AS countryTotal
              FROM picture
              WHERE country IS NOT NULL ${days}
              GROUP BY country
              -- HAVING COUNT(*) >= 20
            ),
            ranked AS (
              SELECT
                pcu.country,
                pcu.userId,
                pcu.pictureCount,
                pc.countryTotal,
                ROW_NUMBER() OVER (
                  PARTITION BY pcu.country
                  ORDER BY pcu.pictureCount DESC, pcu.userId ASC
                ) AS rn
              FROM per_country_user pcu
              JOIN per_country pc USING (country)
            )
          SELECT
            r.country,
            r.userId,
            r.pictureCount,
            u.name AS userName,
            u.picture IS NOT NULL AS userHasPicture,
            (u.premiumExpiration IS NOT NULL AND u.premiumExpiration > NOW()) AS userPremium
          FROM ranked r
          JOIN user u ON u.id = r.userId
          WHERE r.rn <= 30
          ORDER BY r.countryTotal DESC, r.pictureCount DESC
        `),
      );

      const perUser = PerUserDbSchema.parse(
        await pool.query<unknown>(sql`
          SELECT
            COUNT(*) AS pictureCount,
            userId,
            user.name AS userName,
            user.picture IS NOT NULL AS userHasPicture,
            (user.premiumExpiration IS NOT NULL AND user.premiumExpiration > NOW()) AS userPremium
          FROM picture
          JOIN user ON picture.userId = user.id
          WHERE true ${days}
          GROUP BY userId
          ORDER BY pictureCount DESC
          LIMIT 30
        `),
      );

      const { user } = ctx.state;

      let me: { pictureCount: number; userRank: number } | undefined;

      type MeForCountry = {
        country: string;
        pictureCount: number;
        userRank: number;
      };

      let mePerCountry: MeForCountry[] | undefined;

      if (user) {
        mePerCountry = MePerCountryDbSchema.parse(
          await pool.query<unknown>(sql`
            WITH
              per_country_user AS (
                SELECT
                  country,
                  userId,
                  COUNT(*) AS pictureCount
                FROM picture
                WHERE country IS NOT NULL ${days}
                GROUP BY country, userId
              ),
              ranked AS (
                SELECT
                  country,
                  userId,
                  pictureCount,
                  DENSE_RANK() OVER (
                    PARTITION BY country
                    ORDER BY pictureCount DESC
                  ) AS userRank
                FROM per_country_user
              )
            SELECT
              r.country,
              r.pictureCount,
              r.userRank
            FROM ranked r
            WHERE r.userId = ${user.id}
            ORDER BY r.pictureCount DESC, r.userRank DESC
          `),
        );

        const [meme] = MeDbSchema.parse(
          await pool.query<unknown>(sql`
            WITH per_user AS (
              SELECT
                userId,
                COUNT(*) AS pictureCount
              FROM picture
              WHERE true ${days}
              GROUP BY userId
            ),
            ranked AS (
              SELECT
                userId,
                pictureCount,
                DENSE_RANK() OVER (ORDER BY pictureCount DESC) AS userRank
              FROM per_user
            )
            SELECT
              pictureCount,
              userRank
            FROM ranked
            WHERE userId = ${user.id}
          `),
        );

        me = meme;
      }

      const perUserPerCountry: z.infer<typeof PerUserPerCountrySchema> = {};

      for (const {
        country,
        userId,
        userName,
        userHasPicture,
        userPremium,
        pictureCount,
      } of usersPerCountry) {
        (perUserPerCountry[country] ??= []).push({
          user: {
            id: userId,
            name: userName,
            hasPicture: userHasPicture,
            premium: userPremium,
          },
          pictureCount,
        });
      }

      ctx.body = {
        perUserPerCountry,
        perUser: perUser.map((u) => ({
          user: {
            id: u.userId,
            name: u.userName,
            hasPicture: u.userHasPicture,
            premium: u.userPremium,
          },
          pictureCount: u.pictureCount,
        })),
        me: me && {
          perCountry:
            mePerCountry &&
            Object.fromEntries(
              mePerCountry?.map((a) => [
                a.country,
                {
                  pictureCount: a.pictureCount,
                  userRank: a.userRank,
                },
              ]),
            ),
          pictureCount: me.pictureCount,
          userRank: me.userRank,
        },
      } satisfies Stats;
    },
  );
}
