import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import { assert } from 'typia';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { acceptValidator } from '../../requestValidators.js';

export async function attachGetStatsHandler(router: RouterInstance) {
  router.get(
    '/stats',
    authenticator(false),
    acceptValidator('application/json'),
    async (ctx) => {
      const usersPerCountry = assert<
        {
          country: string;
          userId: number;
          userName: string;
          pictureCount: number;
        }[]
      >(
        await pool.query(sql`
          WITH
            per_country_user AS (
              SELECT
                country,
                userId,
                COUNT(*) AS pictureCount
              FROM picture
              WHERE country IS NOT NULL
              GROUP BY country, userId
            ),
            per_country AS (
              SELECT
                country,
                COUNT(*) AS countryTotal
              FROM picture
              WHERE country IS NOT NULL
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
            r.countryTotal
          FROM ranked r
          JOIN user u ON u.id = r.userId
          WHERE r.rn <= 30
          ORDER BY r.countryTotal DESC, r.pictureCount DESC, r.country ASC, r.userId ASC
        `),
      );

      const perUser = assert<
        {
          count: number;
          userId: number;
          userName: string;
        }[]
      >(
        await pool.query(sql`
          SELECT
            COUNT(*) AS "count",
            userId,
            user.name AS userName
          FROM picture
          JOIN user ON picture.userId = user.id
          GROUP BY userId
          ORDER BY "count" ASC
          LIMIT 30
        `),
      );

      const { user } = ctx.state;

      let me: number | undefined;

      type MeForCountry = {
        country: string;
        pictureCount: number;
        userRank: number;
      };

      let mePerCountry: MeForCountry[] | undefined;

      if (user) {
        mePerCountry = assert<MeForCountry[]>(
          await pool.query(sql`
            WITH
              per_country_user AS (
                SELECT
                  country,
                  userId,
                  COUNT(*) AS pictureCount
                FROM picture
                WHERE country IS NOT NULL
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
            ORDER BY r.userRank ASC, r.country ASC
          `),
        );

        const [{ count }] = assert<[{ count: number }]>(
          await pool.query(sql`
            SELECT COUNT(*) AS "count"
            FROM picture
            WHERE userId = ${user.id}
          `),
        );

        me = count;
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
        const group = (perUserPerCountry[country] ??= []);
        group.push({ userId, userName, pictureCount });
      }

      ctx.body = {
        perUserPerCountry,
        perUser,
        mePerCountry,
        me,
      };
    },
  );
}
