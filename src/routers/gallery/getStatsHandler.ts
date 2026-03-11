import { RouterInstance } from '@koa/router';
import sql, { empty } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';

const UsersPerCountrySchema = z.array(
  z.object({
    country: z.string(),
    userId: z.uint32(),
    userName: z.string(),
    pictureCount: z.uint32(),
  }),
);

const PerUserSchema = z.array(
  z.object({
    pictureCount: z.uint32(),
    userId: z.uint32(),
    userName: z.string(),
  }),
);

const MePerCountrySchema = z.array(
  z.object({
    country: z.string(),
    pictureCount: z.uint32(),
    userRank: z.number(),
  }),
);

const MeSchema = z
  .array(
    z.object({
      pictureCount: z.uint32(),
      userRank: z.number(),
    }),
  )
  .max(1);

const StatsSchema = z.strictObject({
  perUserPerCountry: z.record(
    z.string(),
    z
      .strictObject({
        userId: z.uint32(),
        userName: z.string(),
        pictureCount: z.uint32(),
      })
      .array(),
  ),
  perUser: z
    .strictObject({
      pictureCount: z.uint32(),
      userId: z.uint32(),
      userName: z.string(),
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

      console.log(days);

      const usersPerCountry = UsersPerCountrySchema.parse(
        await pool.query(sql`
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
            u.name AS userName
          FROM ranked r
          JOIN user u ON u.id = r.userId
          WHERE r.rn <= 30
          ORDER BY r.countryTotal DESC, r.pictureCount DESC
        `),
      );

      const perUser = PerUserSchema.parse(
        await pool.query(sql`
          SELECT
            COUNT(*) AS pictureCount,
            userId,
            user.name AS userName
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
        mePerCountry = MePerCountrySchema.parse(
          await pool.query(sql`
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

        const [meme] = MeSchema.parse(
          await pool.query(sql`
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

      const perUserPerCountry: Record<
        string,
        {
          userId: number;
          userName: string;
          pictureCount: number;
        }[]
      > = {};

      for (const {
        country,
        userId,
        userName,
        pictureCount,
      } of usersPerCountry) {
        (perUserPerCountry[country] ??= []).push({
          userId,
          userName,
          pictureCount,
        });
      }

      ctx.body = {
        perUserPerCountry,
        perUser,
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
