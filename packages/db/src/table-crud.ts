import { sql, type SQL } from 'drizzle-orm';
import type { CrudService, ListParams, FilterItem } from '@greenhouse/crud/server';
import type { DatabaseProvider } from './provider.js';

/** The kernel field ids stay stable even when an adopted table uses snake_case. */
export interface TableCrudOptions {
  columns: Record<string, string>;
  idField?: string;
  scope?: SQL;
  searchFields?: string[];
  jsonFields?: string[];
}

export function createTableCrudService(
  db: Pick<DatabaseProvider, 'executeRaw'>,
  table: string,
  options: TableCrudOptions,
): CrudService<Record<string, unknown>> & {
  search(query: string, params: ListParams): Promise<{ items: Record<string, unknown>[]; total: number }>;
} {
  const column = (key: string): SQL => {
    const name = options.columns[key];
    if (!name) throw new Error(`Unknown field: ${key}`);
    return sql`${sql.identifier(name)}`;
  };
  const valueFor = (key: string, value: unknown) =>
    options.jsonFields?.includes(key) ? sql`${JSON.stringify(value)}::jsonb` : sql`${value}`;
  const target = sql.identifier(table);
  const selection = sql.join(
    Object.entries(options.columns).map(([key, name]) => sql`${sql.identifier(name)} AS ${sql.identifier(key)}`),
    sql`, `,
  );
  const predicate = (f: FilterItem): SQL => {
    const c = column(f.key),
      v = f.value[0];
    switch (f.method) {
      case 'eq':
        return v == null ? sql`${c} IS NULL` : sql`${c} = ${v}`;
      case 'ne':
        return v == null ? sql`${c} IS NOT NULL` : sql`${c} <> ${v}`;
      case 'like':
      case 'ilike':
        return sql`${c}::text ILIKE ${`%${String(v)}%`}`;
      case 'in':
        return sql`${c} IN (${sql.join(
          f.value.map((x) => sql`${x}`),
          sql`, `,
        )})`;
      case 'nin':
        return sql`${c} NOT IN (${sql.join(
          f.value.map((x) => sql`${x}`),
          sql`, `,
        )})`;
      case 'gt':
        return sql`${c} > ${v}`;
      case 'gte':
        return sql`${c} >= ${v}`;
      case 'lt':
        return sql`${c} < ${v}`;
      case 'lte':
        return sql`${c} <= ${v}`;
      case 'between':
        return sql`${c} BETWEEN ${v} AND ${f.value[1]}`;
      case 'exists':
        return v ? sql`${c} IS NOT NULL` : sql`${c} IS NULL`;
    }
  };
  const where = (extra: SQL[] = []) => sql.join([options.scope ?? sql`true`, ...extra], sql` AND `);
  const byId = (id: string) => where([sql`${column(options.idField ?? 'id')} = ${id}`]);
  async function list(params: ListParams, search?: SQL) {
    const condition = where([...(params.filter ?? []).map(predicate), ...(search ? [search] : [])]);
    const order = params.sort?.length
      ? sql`ORDER BY ${sql.join(
          params.sort.map((s) => sql`${column(s.key)} ${s.order === 'desc' ? sql`DESC` : sql`ASC`}`),
          sql`, `,
        )}`
      : sql`ORDER BY ${column(options.idField ?? 'id')} ASC`;
    const items = await db.executeRaw(
      sql`SELECT ${selection} FROM ${target} WHERE ${condition} ${order} LIMIT ${params.limit ?? 20} OFFSET ${params.skip ?? 0}`,
    );
    const [count] = await db.executeRaw(sql`SELECT count(*)::int AS total FROM ${target} WHERE ${condition}`);
    return { items: items as Record<string, unknown>[], total: Number(count?.total ?? 0) };
  }
  return {
    list,
    search: (query, params) =>
      list(
        params,
        options.searchFields?.length
          ? sql`(${sql.join(
              options.searchFields.map((key) => sql`${column(key)}::text ILIKE ${`%${query}%`}`),
              sql` OR `,
            )})`
          : sql`false`,
      ),
    async get(id) {
      const [row] = await db.executeRaw(sql`SELECT ${selection} FROM ${target} WHERE ${byId(id)} LIMIT 1`);
      return row ?? null;
    },
    async create(data) {
      const entries = Object.entries(data);
      const query = entries.length
        ? sql`INSERT INTO ${target} (${sql.join(
            entries.map(([key]) => column(key)),
            sql`, `,
          )}) VALUES (${sql.join(
            entries.map(([key, value]) => valueFor(key, value)),
            sql`, `,
          )}) RETURNING ${selection}`
        : sql`INSERT INTO ${target} DEFAULT VALUES RETURNING ${selection}`;
      const [row] = await db.executeRaw(query);
      return row;
    },
    async update(id, data) {
      if (!Object.keys(data).length) {
        const [row] = await db.executeRaw(sql`SELECT ${selection} FROM ${target} WHERE ${byId(id)}`);
        return row ?? null;
      }
      const [row] = await db.executeRaw(
        sql`UPDATE ${target} SET ${sql.join(
          Object.entries(data).map(([key, value]) => sql`${column(key)} = ${valueFor(key, value)}`),
          sql`, `,
        )} WHERE ${byId(id)} RETURNING ${selection}`,
      );
      return row ?? null;
    },
    async remove(id) {
      const rows = await db.executeRaw(
        sql`DELETE FROM ${target} WHERE ${byId(id)} RETURNING ${column(options.idField ?? 'id')}`,
      );
      return rows.length > 0;
    },
  };
}
