/**
 * Object ids. React-free (./object-id.test.ts).
 *
 * Since Greenhouse 3.0 every row id is text: a prefixed ULID for new rows (`doc_01J…`) or the
 * decimal string of a row carried over from 1.x (`"42"`). The rule is packages/types/src/object-refs.ts
 * `rowId`, which the server and web use. Ids are compared as strings and never turned into numbers.
 */

export type ObjectId = string;

const LEGACY_ID = /^[1-9][0-9]{0,15}$/;
const ULID_ID = /^[a-z]{2,4}_[0-9A-HJKMNP-TV-Z]{26}$/;

/** A valid id as text, else null. */
export function isObjectId(raw: unknown): raw is ObjectId {
  return typeof raw === 'string' && (LEGACY_ID.test(raw) || ULID_ID.test(raw));
}

/**
 * A route param, link part or saved value → its id, or null. A number is read as a 1.x id
 * (copies the phone saved before 3.0 hold numbers); anything else must pass the rule.
 */
export function objectId(raw: unknown): ObjectId | null {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw > 0 ? String(raw) : null;
  return isObjectId(raw) ? raw : null;
}

/**
 * Creation order for a tie-break: 1.x ids (oldest) by value, then ULIDs, which sort by time as text.
 */
export function compareIds(a: ObjectId, b: ObjectId): number {
  const legacyA = LEGACY_ID.test(a);
  const legacyB = LEGACY_ID.test(b);
  if (legacyA !== legacyB) return legacyA ? -1 : 1;
  if (legacyA && a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}
