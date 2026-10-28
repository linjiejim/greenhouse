/**
 * The `public` schema of a database as comparable data, read from pg_catalog
 * (not pg_dump text): tables, columns (type, nullability, default, identity,
 * generation, collation), constraints, indexes, sequences, views, triggers and
 * functions. Columns are keyed by name, so ordinal position — which differs
 * when a 3.x migration appended a column the 4.0 baseline declares in place —
 * never counts as a difference.
 */
import { openTestConnection } from '@greenhouse/db/test-config';

export interface SchemaCatalog {
  tables: string[];
  columns: Record<string, string>;
  constraints: Record<string, string>;
  indexes: Record<string, string>;
  sequences: Record<string, string>;
  views: Record<string, string>;
  triggers: Record<string, string>;
  functions: Record<string, string>;
}

const byKey = (rows: Array<{ key: string; value: string | null }>) =>
  Object.fromEntries(rows.map((row) => [row.key, row.value ?? '']));

export async function readSchemaCatalog(url: string): Promise<SchemaCatalog> {
  const sql = openTestConnection(url);
  try {
    const tables = await sql<{ name: string }[]>`
      SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`;
    const columns = await sql<{ key: string; value: string }[]>`
      SELECT c.relname || '.' || a.attname AS key,
             concat_ws(' | ', format_type(a.atttypid, a.atttypmod),
                       CASE WHEN a.attnotnull THEN 'not null' ELSE 'null' END,
                       'default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), ''),
                       'identity=' || a.attidentity::text, 'generated=' || a.attgenerated::text,
                       'collation=' || coalesce(co.collname, '')) AS value
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      LEFT JOIN pg_collation co ON co.oid = a.attcollation AND a.attcollation <> 0
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped`;
    const constraints = await sql<{ key: string; value: string }[]>`
      SELECT c.relname || '.' || con.conname AS key,
             con.contype::text || ' ' || pg_get_constraintdef(con.oid) AS value
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'`;
    const indexes = await sql<{ key: string; value: string }[]>`
      SELECT tablename || '.' || indexname AS key, indexdef AS value FROM pg_indexes WHERE schemaname = 'public'`;
    const sequences = await sql<{ key: string; value: string }[]>`
      SELECT s.sequencename AS key,
             concat_ws(' ', s.data_type, s.start_value, s.increment_by, s.min_value, s.max_value, s.cycle,
                       'owned=' || coalesce((
                         SELECT tc.relname || '.' || ta.attname FROM pg_depend dep
                         JOIN pg_class sc ON sc.oid = dep.objid
                         JOIN pg_class tc ON tc.oid = dep.refobjid
                         JOIN pg_attribute ta ON ta.attrelid = dep.refobjid AND ta.attnum = dep.refobjsubid
                         WHERE sc.relname = s.sequencename AND dep.deptype IN ('a', 'i') LIMIT 1), '')) AS value
      FROM pg_sequences s WHERE s.schemaname = 'public'`;
    const views = await sql<{ key: string; value: string }[]>`
      SELECT c.relname AS key, pg_get_viewdef(c.oid) AS value FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')`;
    const triggers = await sql<{ key: string; value: string }[]>`
      SELECT c.relname || '.' || t.tgname AS key, pg_get_triggerdef(t.oid) AS value FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal`;
    const functions = await sql<{ key: string; value: string }[]>`
      SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS key,
             pg_get_functiondef(p.oid) AS value
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')`;
    return {
      tables: tables.map((row) => row.name),
      columns: byKey(columns),
      constraints: byKey(constraints),
      indexes: byKey(indexes),
      sequences: byKey(sequences),
      views: byKey(views),
      triggers: byKey(triggers),
      functions: byKey(functions),
    };
  } finally {
    await sql.end();
  }
}

/** Entries present in only one catalog or different between them, per section. */
export function diffSchemaCatalogs(a: SchemaCatalog, b: SchemaCatalog): string[] {
  const out: string[] = [];
  const onlyIn = (label: string, left: string[], right: string[]) => {
    for (const name of left) if (!right.includes(name)) out.push(`${label}: only in first: ${name}`);
    for (const name of right) if (!left.includes(name)) out.push(`${label}: only in second: ${name}`);
  };
  onlyIn('table', a.tables, b.tables);
  for (const section of ['columns', 'constraints', 'indexes', 'sequences', 'views', 'triggers', 'functions'] as const) {
    const left = a[section];
    const right = b[section];
    onlyIn(section, Object.keys(left), Object.keys(right));
    for (const key of Object.keys(left)) {
      if (key in right && left[key] !== right[key]) out.push(`${section}: ${key}: ${left[key]} ≠ ${right[key]}`);
    }
  }
  return out.sort();
}
