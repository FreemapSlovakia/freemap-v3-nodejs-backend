import type { PoolConnection } from 'mariadb';
import sql, { bulk, empty, join, raw, type Sql } from 'sql-template-tag';
import z from 'zod';
import { afterCommit } from '../../database.js';
import { MAIL_LANGS } from '../../notificationMail.js';
import { labelNewTags } from '../../tagLabeler.js';
import { LATIN, oneLine, PRIVATE_TAG } from './tagNames.js';

/** A picture's tag names, one per line; for a select list over `picture`. */
export const TAG_NAMES_SUBQUERY =
  "(SELECT GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR '\\n') FROM pictureTag pt JOIN tag t ON t.id = pt.tagId WHERE pt.pictureId = picture.id)";

export const LangQuerySchema = z
  .enum(MAIL_LANGS)
  .optional()
  .meta({ description: 'language of tag labels' });

export const TagListSchema = z.array(
  z.strictObject({
    id: z.uint32(),
    name: z.string(),
    label: z
      .string()
      .nullable()
      .meta({ description: 'the name in `lang`, if it differs' }),
    latin: z
      .string()
      .nullable()
      .meta({ description: "a plant's or animal's Latin name" }),
  }),
);

/**
 * A picture's tags as a JSON array of `{ id, name, label, latin }`, `label` in
 * `lang`; for a select list over `picture`.
 */
export function tagListSubquery(lang: string): Sql {
  return sql`(SELECT JSON_ARRAYAGG(JSON_OBJECT('id', t.id, 'name', t.name, 'label', tl.label, 'latin', la.label) ORDER BY t.name)
    FROM pictureTag pt JOIN tag t ON t.id = pt.tagId
    LEFT JOIN tagLabel tl ON tl.tagId = t.id AND tl.language = ${lang}
    LEFT JOIN tagLabel la ON la.tagId = t.id AND la.language = ${LATIN}
    WHERE pt.pictureId = picture.id)`;
}

/** Pictures hidden from all but their author and moderators. */
// IN, not =: MariaDB 11.8 fails a query scanning a spatial index whose
// subquery reads a single row by a unique key ("Update locks cannot be
// acquired during a READ UNCOMMITTED transaction"); a range read is fine.
export const PRIVATE_PICTURE_IDS = raw(
  `SELECT pt.pictureId FROM pictureTag pt JOIN tag t ON t.id = pt.tagId WHERE t.name IN ('${PRIVATE_TAG}', '')`,
);

function cleanNames(names: string[] | null | undefined) {
  return [...new Set((names ?? []).map(oneLine))].filter(Boolean);
}

/** Narrows `picture` to those with any or all of the tags, by name or id. */
export function tagFilterJoin(
  rawNames: string[],
  rawIds: number[],
  mode: 'any' | 'all',
): Sql {
  const names = cleanNames(rawNames);

  const ids = [...new Set(rawIds)];

  const count = names.length + ids.length;

  if (count === 0) {
    return empty;
  }

  // Each value numbered, with the ids of its tags: a name finds a tag by its
  // name, a synonym or a label in any language, so the English or Latin name
  // of a Slovak tag finds it too.
  const valueTags = join(
    [
      ...names.map(
        (n, i) =>
          // IN, not =: see PRIVATE_PICTURE_IDS.
          sql`SELECT ${i} AS v, id FROM tag WHERE name IN (${n}, '')
            UNION ALL SELECT ${i}, tagId FROM tagSynonym WHERE synonym IN (${n}, '')
            UNION ALL SELECT ${i}, tagId FROM tagLabel WHERE label = ${n}`,
      ),
      ...ids.map((id, i) => sql`SELECT ${names.length + i} AS v, ${id} AS id`),
    ],
    ' UNION ALL ',
  );

  // With their narrower tags. UNION, not UNION ALL: a tag reached again (by
  // another path, or a cycle set by hand) adds no row, which ends the walk.
  const matching = sql`FROM pictureTag pt JOIN (
      WITH RECURSIVE vt AS (
        SELECT v, id FROM (${valueTags}) roots
        UNION SELECT vt.v, tp.tagId FROM vt JOIN tagParent tp ON tp.parentId = vt.id
      ) SELECT v, id FROM vt
    ) vt ON pt.tagId = vt.id`;

  // 'all': each value matched by some tag of the picture.
  return mode === 'any'
    ? sql`JOIN (SELECT DISTINCT pt.pictureId ${matching}) AS ptf ON ptf.pictureId = picture.id`
    : sql`JOIN (SELECT pt.pictureId ${matching} GROUP BY pt.pictureId HAVING COUNT(DISTINCT vt.v) = ${count})
        AS ptf ON ptf.pictureId = picture.id`;
}

/**
 * Sets a picture's tags to those `ids` that exist and `names`, creating the
 * names that are no tag's name or synonym. Not by labels: a word of one
 * language can be another's label ("pole"); tagLabeler, seeing the photo,
 * merges instead.
 */
export async function setPictureTags(
  conn: PoolConnection,
  pictureId: number,
  rawNames: string[] | null | undefined,
  rawIds: number[] | null | undefined,
) {
  const names = cleanNames(rawNames);

  // Existing tags by their ids, which a rename keeps. TODO tags left with no
  // photos stay.
  const ids = new Set(rawIds ?? []);

  const created: string[] = [];

  // The existing tags found by name, by id.
  const namedIds = new Map<number, string>();

  if (names.length) {
    const found = z
      .array(
        z.object({
          typed: z.string(),
          tagged: z.uint32().nullable(),
        }),
      )
      .parse(
        await conn.query<unknown>(
          // Not locked: a locking read of a name not there yet takes a gap
          // lock, and two saves creating one tag deadlock.
          sql`SELECT typedNames.typed, COALESCE(t.id, ts.tagId) AS tagged
            FROM (${join(
              names.map(
                (n) =>
                  sql`SELECT CONVERT(${n} USING utf8mb4) COLLATE utf8mb4_unicode_ci AS typed`,
              ),
              ' UNION ALL ',
            )}) typedNames
            LEFT JOIN tag t ON t.name = typedNames.typed
            LEFT JOIN tagSynonym ts ON ts.synonym = typedNames.typed`,
        ),
      );

    for (const { typed, tagged } of found) {
      if (tagged !== null) {
        ids.add(tagged);

        namedIds.set(tagged, typed);
      } else {
        created.push(typed);
      }
    }
  }

  // Only the new ones: an upsert would lock a popular tag for every save
  // naming it until commit. A name created meanwhile is a duplicate, kept.
  const create = async (newNames: string[]) => {
    if (newNames.length) {
      await conn.query<unknown>(
        sql`INSERT INTO tag (name) VALUES ${bulk(newNames.map((name) => [name]))} ON DUPLICATE KEY UPDATE id = id`,
      );
    }
  };

  // Shared locks: saves don't wait for each other, but tagLabeler waits to
  // rename or merge one of these until commit.
  const lock = async () =>
    created.length + ids.size === 0
      ? []
      : z
          .array(z.object({ id: z.uint32(), labeled: z.coerce.boolean() }))
          .parse(
            await conn.query<unknown>(
              sql`SELECT id, labeledAt IS NOT NULL AS labeled FROM tag WHERE ${join(
                [
                  ...(created.length ? [sql`name IN (${join(created)})`] : []),
                  ...(ids.size ? [sql`id IN (${join([...ids])})`] : []),
                ],
                ' OR ',
              )} LOCK IN SHARE MODE`,
            ),
          );

  await create(created);

  let tags = await lock();

  // A name whose tag was merged away since the lookup is created anew (and
  // merged again by tagLabeler). TODO a synonym so created shadows the one
  // the merge moved.
  const vanished = [...namedIds].filter(
    ([id]) => !tags.some((t) => t.id === id),
  );

  if (vanished.length) {
    for (const [id, name] of vanished) {
      ids.delete(id);

      created.push(name);
    }

    await create(vanished.map(([, name]) => name));

    tags = await lock();
  }

  // A tag gone meanwhile (merged by tagLabeler) may have moved its link to
  // another one the picture should keep, so nothing is removed then.
  const complete = [...ids].every((id) => tags.some((t) => t.id === id));

  if (complete) {
    await conn.query<unknown>(
      sql`DELETE FROM pictureTag WHERE pictureId = ${pictureId}
        ${tags.length ? sql`AND tagId NOT IN (${join(tags.map(({ id }) => id))})` : empty}`,
    );
  }

  if (tags.length === 0) {
    return;
  }

  await conn.query<unknown>(
    sql`INSERT INTO pictureTag (pictureId, tagId) VALUES ${bulk(tags.map(({ id }) => [pictureId, id]))}
      ON DUPLICATE KEY UPDATE tagId = tagId`,
  );

  if (tags.some(({ labeled }) => !labeled)) {
    afterCommit(conn, labelNewTags);
  }
}
