import { StringDecoder } from 'node:string_decoder';

/**
 * Minimal streaming parser for mysqldump output (as produced for the Wikimedia
 * `commonswiki-*.sql.gz` table dumps). It understands just enough SQL to:
 *
 *  - learn a table's column order from its `CREATE TABLE` statement, and
 *  - stream every row out of the extended `INSERT INTO … VALUES (…),(…),…;`
 *    statements as arrays of decoded field values.
 *
 * Dumps use default mysqldump formatting: no column list on inserts (so column
 * order must come from the `CREATE TABLE`), backslash-escaped string literals,
 * and extended inserts of up to ~1 MB per statement.
 */

export type SqlValue = string | number | null;

/** A parsed row plus the column names it maps to (in dump order). */
export type ParsedRow = { columns: string[]; values: SqlValue[] };

type Chunks = AsyncIterable<Buffer> | AsyncIterable<Uint8Array>;

export type StreamOptions = {
  /**
   * Stop extracting after this many columns per row (the rest of each tuple is
   * skipped without building values). Set it to one past the highest column
   * index you actually read — a big speedup on wide tables like `page`.
   */
  maxFields?: number;
};

const CREATE_RE = /CREATE TABLE `([^`]+)` \(([\s\S]*?)\n\)/;

/** Extract column names, in order, from a `CREATE TABLE` statement body. */
function parseColumns(body: string): string[] {
  const columns: string[] = [];

  for (const line of body.split('\n')) {
    const trimmed = line.trim();

    // Column definitions start with a backtick-quoted name; index/key/constraint
    // clauses (PRIMARY KEY, KEY, UNIQUE, CONSTRAINT, SPATIAL, FULLTEXT) do not.
    const m = /^`([^`]+)`\s/.exec(trimmed);

    if (m) {
      columns.push(m[1]);
    } else if (
      /^(PRIMARY|UNIQUE|KEY|CONSTRAINT|SPATIAL|FULLTEXT|INDEX)\b/i.test(trimmed)
    ) {
      break;
    }
  }

  return columns;
}

/** Parse the `(…),(…),…` value-tuples portion of an INSERT into rows. */
function* parseValues(
  values: string,
  maxFields: number,
): Generator<SqlValue[]> {
  let i = 0;
  const n = values.length;

  while (i < n) {
    // Advance to the next opening paren of a tuple.
    while (i < n && values[i] !== '(') {
      i++;
    }

    if (i >= n) {
      return;
    }

    i++; // consume '('

    const row: SqlValue[] = [];
    let field = '';
    let inString = false;
    let quoted = false;
    let capped = false;

    for (; i < n; i++) {
      const c = values[i];

      if (inString) {
        if (c === '\\') {
          // Backslash escape — decode the common mysqldump escapes.
          const next = values[++i];

          field +=
            next === 'n'
              ? '\n'
              : next === 'r'
                ? '\r'
                : next === 't'
                  ? '\t'
                  : next === '0'
                    ? '\0'
                    : next; // \' \" \\ and anything else → literal
        } else if (c === "'") {
          inString = false;
        } else {
          field += c;
        }
      } else if (c === "'") {
        inString = true;
        quoted = true;
      } else if (c === ',') {
        row.push(finishField(field, quoted));
        field = '';
        quoted = false;

        if (maxFields && row.length >= maxFields) {
          capped = true;
          i++; // move past the comma before skipping
          break;
        }
      } else if (c === ')') {
        row.push(finishField(field, quoted));
        i++; // consume ')'
        break;
      } else {
        field += c;
      }
    }

    // We stopped after `maxFields` columns — skip the rest of this tuple (still
    // honoring string quoting/escapes) to reach the next one.
    if (capped) {
      let s = false;

      for (; i < n; i++) {
        const c = values[i];

        if (s) {
          if (c === '\\') {
            i++;
          } else if (c === "'") {
            s = false;
          }
        } else if (c === "'") {
          s = true;
        } else if (c === ')') {
          i++;
          break;
        }
      }
    }

    yield row;
  }
}

/** Turn an accumulated raw field into NULL / number / string. */
function finishField(raw: string, quoted: boolean): SqlValue {
  if (quoted) {
    return raw;
  }

  const trimmed = raw.trim();

  if (trimmed === 'NULL' || trimmed === '') {
    return null;
  }

  const num = Number(trimmed);

  return Number.isNaN(num) ? trimmed : num;
}

/**
 * Stream rows of `tableName` from a mysqldump byte stream. Emits one
 * {@link ParsedRow} per row, with column names resolved from the dump's
 * `CREATE TABLE`. Statements are split on top-level (unquoted) semicolons.
 *
 * The scan is single-pass: each character is examined once (never re-scanned
 * across chunk boundaries), and the buffer is compacted after every chunk.
 */
export async function* streamDumpRows(
  chunks: Chunks,
  tableName: string,
  opts: StreamOptions = {},
): AsyncGenerator<ParsedRow> {
  const decoder = new StringDecoder('utf8');
  const insertPrefix = `INSERT INTO \`${tableName}\` VALUES `;
  const maxFields = opts.maxFields ?? 0;

  let buf = '';
  let scanned = 0; // chars already examined for statement boundaries
  let start = 0; // start of the current (unterminated) statement
  let inString = false;
  let escaped = false;
  let columns: string[] | null = null;

  for await (const chunk of chunks) {
    buf += decoder.write(Buffer.from(chunk));

    for (; scanned < buf.length; scanned++) {
      const c = buf[scanned];

      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (inString) {
        if (c === "'") {
          inString = false;
        }
      } else if (c === "'") {
        inString = true;
      } else if (c === ';') {
        const parsed = handleStatement(
          buf.slice(start, scanned),
          tableName,
          insertPrefix,
          columns,
          maxFields,
        );

        start = scanned + 1;

        if (parsed.columns) {
          columns = parsed.columns;
        }

        if (parsed.values && columns) {
          for (const values of parsed.values) {
            yield { columns, values };
          }
        }
      }
    }

    // Drop the processed prefix so the buffer doesn't grow without bound.
    if (start > 0) {
      buf = buf.slice(start);
      scanned -= start;
      start = 0;
    }
  }
}

function handleStatement(
  stmt: string,
  tableName: string,
  insertPrefix: string,
  columns: string[] | null,
  maxFields: number,
): { columns?: string[]; values?: Generator<SqlValue[]> } {
  const trimmed = stmt.trimStart();

  if (trimmed.startsWith('CREATE TABLE')) {
    const m = CREATE_RE.exec(trimmed);

    if (m && m[1] === tableName) {
      return { columns: parseColumns(m[2]) };
    }

    return {};
  }

  if (columns && trimmed.startsWith(insertPrefix)) {
    return {
      values: parseValues(trimmed.slice(insertPrefix.length), maxFields),
    };
  }

  return {};
}
