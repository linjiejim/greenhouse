/**
 * Extension tables for `migrate-from-1x`: copied verbatim.
 *
 * An extension table is any public table of the source that the 1.x core chain
 * did not create (crm_*, sellfox_*, …), plus `extension_migrations` itself.
 * The DDL is rebuilt from the source catalog (columns with their types,
 * defaults, NOT NULL and generated expressions; owned sequences; primary /
 * unique / check constraints; other indexes; foreign keys last), then the rows
 * stream across with COPY, then sequences are set to the source's position.
 */

import type postgres from 'postgres';

type Sql = postgres.Sql;

const BOOKKEEPING = 'extension_migrations';

export function discoverExtensionTables(sourceTables: Set<string>, coreTables: Set<string>): string[] {
  return [...sourceTables].filter((name) => !coreTables.has(name)).sort();
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

export async function dropTables(target: Sql, tables: string[]): Promise<void> {
  const extensions = tables.filter((name) => name !== BOOKKEEPING);
  if (extensions.length > 0) {
    await target.unsafe(`DROP TABLE IF EXISTS ${extensions.map(ident).join(', ')} CASCADE`);
  }
  if (tables.includes(BOOKKEEPING)) await target.unsafe(`DELETE FROM ${ident(BOOKKEEPING)}`);
}

interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  default: string | null;
  generated: string | null;
}

async function columnsOf(source: Sql, table: string): Promise<ColumnInfo[]> {
  const rows = await source`
    SELECT a.attname AS name,
           format_type(a.atttypid, a.atttypmod) AS type,
           a.attnotnull AS not_null,
           a.attgenerated AS generated_kind,
           pg_get_expr(d.adbin, d.adrelid) AS expr
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = ${`public.${ident(table)}`}::regclass AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum`;
  return rows.map((row) => ({
    name: String(row.name),
    type: String(row.type),
    notNull: Boolean(row.not_null),
    default: row.generated_kind ? null : (row.expr as string | null),
    generated: row.generated_kind ? (row.expr as string | null) : null,
  }));
}

async function constraintsOf(source: Sql, table: string): Promise<Array<{ name: string; type: string; def: string }>> {
  const rows = await source`
    SELECT conname AS name, contype AS type, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = ${`public.${ident(table)}`}::regclass
    ORDER BY contype, conname`;
  return rows.map((row) => ({ name: String(row.name), type: String(row.type), def: String(row.def) }));
}

async function indexesOf(source: Sql, table: string): Promise<string[]> {
  const rows = await source`
    SELECT pg_get_indexdef(i.indexrelid) AS def
    FROM pg_index i
    WHERE i.indrelid = ${`public.${ident(table)}`}::regclass
      AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid)`;
  return rows.map((row) => String(row.def));
}

/** Sequences named in `nextval('…')` defaults. */
function sequencesIn(columns: ColumnInfo[]): string[] {
  const names = new Set<string>();
  for (const column of columns) {
    const match = column.default?.match(/nextval\('([^']+)'::regclass\)/);
    if (match?.[1]) names.add(match[1].replace(/^public\./, '').replace(/"/g, ''));
  }
  return [...names];
}

export async function copyExtensionTables(
  source: Sql,
  target: Sql | null,
  tables: string[],
  log: (line: string) => void,
  note: (text: string) => void = () => {},
): Promise<Array<{ table: string; rows: number }>> {
  const result: Array<{ table: string; rows: number }> = [];
  const foreignKeys: Array<{ table: string; name: string; def: string }> = [];
  for (const table of tables) {
    const [count] = await source.unsafe(`SELECT count(*)::bigint AS n FROM ${ident(table)}`);
    const rows = Number(count?.n ?? 0);
    result.push({ table, rows });
    if (!target) continue;

    const columns = await columnsOf(source, table);
    const writable = columns.filter((column) => !column.generated).map((column) => ident(column.name));
    if (table !== BOOKKEEPING) {
      const sequences = sequencesIn(columns);
      for (const sequence of sequences) await target.unsafe(`CREATE SEQUENCE IF NOT EXISTS ${ident(sequence)}`);
      const definitions = columns.map((column) => {
        let line = `${ident(column.name)} ${column.type}`;
        if (column.generated) line += ` GENERATED ALWAYS AS (${column.generated}) STORED`;
        else if (column.default !== null) line += ` DEFAULT ${column.default}`;
        if (column.notNull) line += ' NOT NULL';
        return line;
      });
      await target.unsafe(`CREATE TABLE ${ident(table)} (${definitions.join(', ')})`);
      for (const constraint of await constraintsOf(source, table)) {
        if (constraint.type === 'f') foreignKeys.push({ table, name: constraint.name, def: constraint.def });
        else
          await target.unsafe(`ALTER TABLE ${ident(table)} ADD CONSTRAINT ${ident(constraint.name)} ${constraint.def}`);
      }
      for (const index of await indexesOf(source, table)) await target.unsafe(index);
      for (const column of columns) {
        const match = column.default?.match(/nextval\('([^']+)'::regclass\)/);
        const sequence = match?.[1]?.replace(/^public\./, '').replace(/"/g, '');
        if (sequence) {
          await target.unsafe(`ALTER SEQUENCE ${ident(sequence)} OWNED BY ${ident(table)}.${ident(column.name)}`);
        }
      }
    }

    if (rows > 0) {
      const columnList = writable.join(', ');
      const reader = await source.unsafe(`COPY ${ident(table)} (${columnList}) TO STDOUT`).readable();
      const writer = await target.unsafe(`COPY ${ident(table)} (${columnList}) FROM STDIN`).writable();
      await new Promise<void>((resolve, reject) => {
        reader.on('error', reject);
        writer.on('error', reject);
        writer.on('finish', () => resolve());
        reader.pipe(writer);
      });
    }

    if (table !== BOOKKEEPING) {
      for (const sequence of sequencesIn(columns)) {
        const [position] = await source.unsafe(`SELECT last_value::text AS value, is_called FROM ${ident(sequence)}`);
        if (position) {
          await target.unsafe(
            `SELECT setval('${ident(sequence)}', ${Number(position.value)}, ${position.is_called ? 'true' : 'false'})`,
          );
        }
      }
    }
    log(`  ${table}: ${rows} rows copied`);
  }
  for (const foreignKey of foreignKeys) {
    if (!target) break;
    try {
      await target.unsafe(
        `ALTER TABLE ${ident(foreignKey.table)} ADD CONSTRAINT ${ident(foreignKey.name)} ${foreignKey.def}`,
      );
    } catch (error) {
      // A key into a 1.x table 3.0 renamed or retired: the data is copied, the constraint is not.
      note(
        `foreign key ${foreignKey.table}.${foreignKey.name} not recreated (${foreignKey.def}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return result;
}
