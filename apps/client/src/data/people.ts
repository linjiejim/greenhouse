/**
 * Member names for the ids plugin records hold (`user` fields), as
 * `POST /api/people/resolve` `{ ids }` answers them: `{ people: [{ id, name }] }`.
 * React-free (./people.test.ts).
 */

/** At most this many ids per request (the route's own cap). */
export const PEOPLE_BATCH = 200;

/** The member ids `rows` name in the given fields, each once, in first-seen order. */
export function peopleIds(
  fields: readonly { key: string; kind: string }[],
  rows: readonly Record<string, unknown>[],
): string[] {
  const keys = fields.filter((f) => f.kind === 'user').map((f) => f.key);
  const ids = new Set<string>();
  for (const row of rows)
    for (const key of keys) {
      const id = row[key];
      // a masked field reads '***': nothing to resolve
      if (typeof id === 'string' && id && id !== '***') ids.add(id);
    }
  return [...ids];
}

/** The answer as id → name; anything malformed is skipped. */
export function parsePeople(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const people = (body as { people?: unknown } | null)?.people;
  if (!Array.isArray(people)) return out;
  for (const raw of people) {
    const item = raw as Record<string, unknown> | null;
    if (item && typeof item.id === 'string' && typeof item.name === 'string' && item.name.trim())
      out[item.id] = item.name;
  }
  return out;
}
