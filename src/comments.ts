import type { ParameterizedContext } from 'koa';
import type { Pool, PoolConnection } from 'mariadb';
import sql, { raw, type Sql } from 'sql-template-tag';
import z from 'zod';
import { runInTransaction } from './database.js';
import { hasRole, type Role } from './roles.js';
import { zDateToIso } from './types.js';

/** How long after posting its author may edit a comment. */
export const COMMENT_EDIT_WINDOW_MS = 60 * 60 * 1000;

export const CommentBodySchema = z
  .strictObject({ comment: z.string().trim().min(1).max(4096) })
  .meta({ id: 'CommentBody' });

export const DeletedBySchema = z.enum(['author', 'owner', 'moderator']);

/** A deleted comment keeps its place and time but neither its text nor its author. */
export const CommentSchema = z
  .strictObject({
    id: z.uint32(),
    createdAt: zDateToIso,
    editedAt: zDateToIso.nullable(),
    deletedAt: zDateToIso.nullable(),
    deletedBy: DeletedBySchema.nullable(),
    comment: z.string().nullable(),
    user: z
      .strictObject({
        id: z.uint32(),
        name: z.string(),
        hasPicture: z.boolean(),
        premium: z.boolean(),
      })
      .nullable(),
  })
  .meta({ id: 'Comment' });

export type CommentTable =
  | 'pictureComment'
  | 'wikimediaComment'
  | 'eventComment';

const TABLES: Record<
  CommentTable,
  { parent: string; owner: Sql; moderator: Role }
> = {
  pictureComment: {
    parent: 'pictureId',
    owner: sql`(SELECT userId FROM picture WHERE id = c.pictureId)`,
    moderator: 'galleryModerator',
  },
  // A Commons photo has no owner here.
  wikimediaComment: {
    parent: 'pageId',
    owner: sql`NULL`,
    moderator: 'galleryModerator',
  },
  eventComment: {
    parent: 'eventId',
    owner: sql`(SELECT userId FROM event WHERE id = c.eventId)`,
    moderator: 'eventManager',
  },
};

const RowSchema = z.object({
  id: z.uint32(),
  createdAt: z.date(),
  editedAt: z.date().nullable(),
  deletedAt: z.date().nullable(),
  deletedBy: DeletedBySchema.nullable(),
  comment: z.string().nullable(),
  userId: z.uint32(),
  name: z.string(),
  hasPicture: z.coerce.boolean(),
  premium: z.coerce.boolean(),
});

function select(table: CommentTable) {
  return sql`SELECT c.id, c.createdAt, c.editedAt, c.deletedAt, c.deletedBy, c.comment,
      c.userId, u.name, u.picture IS NOT NULL AS hasPicture,
      (u.premiumExpiration IS NOT NULL AND u.premiumExpiration > NOW()) AS premium
    FROM ${raw(table)} c JOIN user u ON u.id = c.userId`;
}

function rowToComment(row: z.infer<typeof RowSchema>) {
  const deleted = row.deletedBy !== null;

  return CommentSchema.parse({
    id: row.id,
    createdAt: row.createdAt,
    editedAt: deleted ? null : row.editedAt,
    deletedAt: row.deletedAt,
    deletedBy: row.deletedBy,
    comment: deleted ? null : row.comment,
    user: deleted
      ? null
      : {
          id: row.userId,
          name: row.name,
          hasPicture: row.hasPicture,
          premium: row.premium,
        },
  });
}

/** The thread on a photo or event, oldest first. */
export async function listComments(
  db: Pool | PoolConnection,
  table: CommentTable,
  parentId: number | string,
) {
  return RowSchema.array()
    .parse(
      await db.query<unknown>(
        sql`${select(table)} WHERE c.${raw(TABLES[table].parent)} = ${parentId}
          ORDER BY c.createdAt, c.id`,
      ),
    )
    .map(rowToComment);
}

export async function getComment(
  db: Pool | PoolConnection,
  table: CommentTable,
  id: number,
) {
  const [row] = RowSchema.array()
    .length(1)
    .parse(await db.query<unknown>(sql`${select(table)} WHERE c.id = ${id}`));

  return rowToComment(row);
}

type Target = {
  table: CommentTable;
  parentId: number | string;
  commentId: number;
};

async function lockComment(
  conn: PoolConnection,
  ctx: ParameterizedContext,
  { table, parentId, commentId }: Target,
) {
  const [row] = z
    .array(
      z.object({
        userId: z.uint32(),
        createdAt: z.date(),
        deleted: z.coerce.boolean(),
        ownerId: z.uint32().nullable(),
      }),
    )
    .max(1)
    .parse(
      await conn.query<unknown>(
        sql`SELECT c.userId, c.createdAt, c.deletedAt IS NOT NULL AS deleted,
            ${TABLES[table].owner} AS ownerId
          FROM ${raw(table)} c
          WHERE c.id = ${commentId} AND c.${raw(TABLES[table].parent)} = ${parentId}
          FOR UPDATE`,
      ),
    );

  if (!row || row.deleted) {
    ctx.throw(404, 'no such comment');
  }

  return row;
}

/** Its author edits a comment within {@link COMMENT_EDIT_WINDOW_MS}; answers with it. */
export async function editComment(
  ctx: ParameterizedContext,
  target: Target,
  comment: string,
) {
  return runInTransaction(async (conn) => {
    const row = await lockComment(conn, ctx, target);

    if (row.userId !== ctx.state.user!.id) {
      ctx.throw(403);
    }

    if (Date.now() - row.createdAt.getTime() > COMMENT_EDIT_WINDOW_MS) {
      ctx.throw(403, 'the comment can no longer be edited');
    }

    await conn.query<unknown>(
      sql`UPDATE ${raw(target.table)} SET comment = ${comment}, editedAt = NOW()
        WHERE id = ${target.commentId}`,
    );

    return getComment(conn, target.table, target.commentId);
  });
}

/**
 * Its author, the photo's or event's owner, or a moderator deletes a comment:
 * its text is wiped, the row stays as a placeholder. Answers with it.
 */
export async function deleteComment(ctx: ParameterizedContext, target: Target) {
  const user = ctx.state.user!;

  return runInTransaction(async (conn) => {
    const row = await lockComment(conn, ctx, target);

    const deletedBy =
      row.userId === user.id
        ? 'author'
        : row.ownerId === user.id
          ? 'owner'
          : hasRole(user, TABLES[target.table].moderator)
            ? 'moderator'
            : ctx.throw(403);

    await conn.query<unknown>(
      sql`UPDATE ${raw(target.table)}
        SET comment = '', deletedAt = NOW(), deletedBy = ${deletedBy}
        WHERE id = ${target.commentId}`,
    );

    return getComment(conn, target.table, target.commentId);
  });
}
