import { createHmac } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { RouterInstance } from '@koa/router';
import type { ParameterizedContext } from 'koa';
import sql, { empty, raw } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { CommentSchema, listComments } from '../../comments.js';
import { pool } from '../../database.js';
import { getEnv } from '../../env.js';
import { appLogger } from '../../logger.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { zDateToIso, zNullableDateToIso } from '../../types.js';
import { picturesDir } from './constants.js';
import { PictureIdParamSchema, parsePictureId } from './pictureId.js';
import { ratingExp, ratingSubquery } from './ratingConstants.js';
import {
  LangQuerySchema,
  TAG_NAMES_SUBQUERY,
  TagListSchema,
  tagListSubquery,
} from './tags.js';

const secret = getEnv('PREMIUM_PHOTO_SECRET', '');

const PictureDbRowSchema = z.object({
  pictureId: z.uint32(),
  createdAt: zDateToIso,
  pathname: z.string().nonempty(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  takenAt: zNullableDateToIso,
  lat: z.number(),
  lon: z.number(),
  azimuth: z.number().nullable(),
  pano: z.boolean(),
  userId: z.uint32().nullable(),
  name: z.string().nullable(),
  hasPicture: z.coerce.boolean(),
  userPremium: z.coerce.boolean(),
  premium: z.boolean(),
  license: z.string(),
  licenseSince: zNullableDateToIso,
  tags: z
    .string()
    .nullable()
    .transform((t) => (t ? t.split('\n') : []))
    .pipe(z.array(z.string())),
  // The driver parses the JSON where the server marks it so; NULL for a
  // picture with no tags.
  tagList: z.preprocess(
    (t) => (typeof t === 'string' ? JSON.parse(t) : (t ?? [])),
    TagListSchema,
  ),
  rating: z.number(),
  myStars: z.number().nullish(),
  viewCount: z.number(),
});

const UserSchema = z.strictObject({
  id: z.uint32(),
  name: z.string(),
  hasPicture: z.boolean(),
  premium: z.boolean(),
});

const ResponseBodySchema = PictureDbRowSchema.omit({
  pictureId: true,
  pathname: true,
  userId: true,
  name: true,
  hasPicture: true,
  userPremium: true,
}).extend({
  id: z.uint32(),
  source: z.literal('gallery'),
  user: UserSchema.nullable(),
  comments: CommentSchema.array(),
  hmac: z.string().optional(),
  size: z.number().optional(),
});

type ResponseBody = z.infer<typeof ResponseBodySchema>;

export function attachGetPictureHandler(router: RouterInstance) {
  registerPath('/gallery/pictures/{id}', {
    get: {
      summary: 'Get a single gallery picture',
      tags: ['gallery'],
      security: AUTH_OPTIONAL,
      requestParams: {
        path: z.object({ id: PictureIdParamSchema }),
        query: z.object({
          countView: z
            .literal('1')
            .optional()
            .describe(
              'Count this request as a view; omitted when re-fetching a shown picture',
            ),
          lang: LangQuerySchema,
        }),
      },
      responses: {
        200: {
          content: { 'application/json': { schema: ResponseBodySchema } },
        },
        401: {},
        404: { description: 'no such picture' },
      },
    },
  });

  router.get(
    '/pictures/:id',
    acceptValidator('application/json'),
    authenticator(false, 'gallery:read'),
    async (ctx) => {
      const ref = parsePictureId(ctx.params.id);

      if (!ref) {
        return ctx.throw(404, 'no such picture');
      }

      if (ref.source === 'wikimedia') {
        await respondWikimedia(ctx, ref.pageId);

        return;
      }

      const [row] = PictureDbRowSchema.array()
        .max(1)
        .parse(
          await pool.query<unknown>(sql`
            SELECT
              picture.id AS pictureId,
              picture.createdAt,
              pathname,
              title,
              picture.description,
              takenAt,
              ST_X(location) AS lon,
              ST_Y(location) AS lat,
              azimuth,
              pano,
              premium,
              license,
              viewCount,
              (SELECT MAX(changedAt) FROM pictureLicenseHistory WHERE pictureId = picture.id) AS licenseSince,
              user.id as userId,
              user.name,
              user.picture IS NOT NULL AS hasPicture,
              (user.premiumExpiration IS NOT NULL AND user.premiumExpiration > NOW()) AS userPremium,
              ${raw(TAG_NAMES_SUBQUERY)} AS tags,
              ${tagListSubquery(LangQuerySchema.catch(undefined).parse(ctx.query.lang) ?? '')} AS tagList,
              ${raw(ratingSubquery)}
              ${
                ctx.state.user
                  ? sql`, (SELECT stars FROM pictureRating WHERE pictureId = picture.id AND userId = ${ctx.state.user!.id}) AS myStars`
                  : empty
              }
            FROM picture LEFT JOIN user ON userId = user.id
            WHERE picture.id = ${ref.id}`),
        );

      if (!row) {
        ctx.throw(404, 'no such picture');
      }

      let { viewCount } = row;

      const { user } = ctx.state;

      // Not of a premium photo the viewer can't see.
      if (
        ctx.query.countView === '1' &&
        (!row.premium ||
          row.userId === user?.id ||
          (!!user?.premiumExpiration && user.premiumExpiration > new Date()))
      ) {
        try {
          await pool.query<unknown>(
            sql`UPDATE picture SET viewCount = viewCount + 1 WHERE id = ${ref.id}`,
          );

          viewCount++;
        } catch (err) {
          // A cosmetic counter must not keep the photo from opening.
          appLogger
            .child({ module: 'getPicture', reqId: ctx.reqId })
            .warn({ err }, 'counting a view failed');
        }
      }

      const comments = await listComments(pool, 'pictureComment', ref.id);

      const {
        pictureId,
        createdAt,
        title,
        description,
        takenAt,
        lat,
        lon,
        azimuth,
        userId,
        name,
        hasPicture,
        userPremium,
        tags,
        tagList,
        rating,
        myStars,
        pano,
        premium,
        license,
        licenseSince,
        pathname,
      } = row;

      let size;
      try {
        size = (await stat(path.join(picturesDir, pathname))).size;
      } catch {
        // ignore
      }

      ctx.body = {
        id: pictureId,
        source: 'gallery',
        createdAt,
        title,
        description,
        takenAt,
        lat,
        lon,
        azimuth,
        user:
          userId === null || name === null
            ? null
            : {
                id: userId,
                name,
                hasPicture,
                premium: userPremium,
              },
        tags,
        tagList,
        comments,
        rating,
        myStars,
        pano,
        premium,
        license,
        licenseSince,
        viewCount,
        hmac:
          premium && secret
            ? createHmac('sha256', secret)
                .update(String(pictureId))
                .digest('hex')
            : undefined,
        size,
      } satisfies ResponseBody;
    },
  );
}

const WikimediaRowSchema = z.object({
  lat: z.number(),
  lon: z.number(),
  uploadedAt: zNullableDateToIso,
  rating: z.number(),
  myStars: z.number().nullish(),
});

/**
 * Detail for a Wikimedia Commons photo. Only what the server actually owns is
 * returned — position and the gallery-native rating/comments. The title, image
 * URL, author, license and description are fetched by the client straight from
 * the Commons API by pageId.
 */
async function respondWikimedia(
  ctx: ParameterizedContext,
  pageId: number,
): Promise<void> {
  const [row] = WikimediaRowSchema.array()
    .max(1)
    .parse(
      await pool.query<unknown>(sql`
        SELECT
          ST_X(location) AS lon,
          ST_Y(location) AS lat,
          uploadedAt,
          (SELECT ${raw(ratingExp)} FROM wikimediaRating WHERE pageId = ${pageId}) AS rating
          ${
            ctx.state.user
              ? sql`, (SELECT stars FROM wikimediaRating WHERE pageId = ${pageId} AND userId = ${ctx.state.user.id}) AS myStars`
              : empty
          }
        FROM wikimediaPicture
        WHERE pageId = ${pageId}`),
    );

  if (!row) {
    ctx.throw(404, 'no such picture');
  }

  const comments = await listComments(pool, 'wikimediaComment', pageId);

  ctx.body = {
    id: pageId,
    source: 'wikimedia',
    title: null,
    lat: row.lat,
    lon: row.lon,
    createdAt: row.uploadedAt,
    tags: [],
    tagList: [],
    comments,
    rating: row.rating,
    myStars: row.myStars ?? null,
  };
}
