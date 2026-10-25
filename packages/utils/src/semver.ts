/**
 * Minimal semver helpers for skill versioning (strict `X.Y.Z`, numeric parts only).
 *
 * Deliberately NOT a full semver implementation: no pre-release / build tags —
 * Skill Center versions are plain three-part numbers, and rejecting anything
 * else keeps ordering unambiguous. Invalid input is a caller bug, so the
 * comparing/bumping helpers throw instead of guessing.
 */

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Parse a strict `X.Y.Z` version, or null when it does not conform. */
export function parseSemver(version: string): Semver | null {
  const m = SEMVER_RE.exec(version);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** True when `version` is a strict `X.Y.Z` string (no leading zeros, no tags). */
export function isValidSemver(version: string): boolean {
  return SEMVER_RE.test(version);
}

/** Compare two versions: negative when a < b, 0 when equal, positive when a > b. Throws on invalid input. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa) throw new Error(`Invalid semver: "${a}"`);
  if (!pb) throw new Error(`Invalid semver: "${b}"`);
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}

/** Next patch version (`1.2.3` → `1.2.4`). Throws on invalid input. */
export function bumpPatch(version: string): string {
  const p = parseSemver(version);
  if (!p) throw new Error(`Invalid semver: "${version}"`);
  return `${p.major}.${p.minor}.${p.patch + 1}`;
}

// ─── Ranges (extension compatibility) ───────────────────

type Triple = [number, number, number];

/**
 * The release triple of a version string: an optional `v`, one to three numeric
 * parts, an optional pre-release / build suffix (`3.0.0-rc.3` → `[3, 0, 0]`).
 * Null when the string is not a version.
 */
export function releaseTriple(version: string): Triple | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

const cmp = (a: Triple, b: Triple) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** One comparator as a half-open interval: `lo <= v` (or `<`) and `v < hi` (or `<=`). */
interface Bound {
  lo?: Triple;
  loExclusive?: boolean;
  hi?: Triple;
  hiInclusive?: boolean;
}

function parseComparator(raw: string): Bound {
  const m = /^(>=|<=|>|<|=|\^|~)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?$/.exec(raw);
  if (!m) throw new Error(`Invalid version range comparator: "${raw}"`);
  const op = m[1] ?? '=';
  const parts = [m[2], m[3], m[4]];
  // How many leading numeric parts were given (a wildcard ends the version).
  let given = 0;
  while (given < 3 && parts[given] !== undefined && /^\d+$/.test(parts[given]!)) given++;
  if (given === 0) return {};
  const v: Triple = [0, 0, 0];
  for (let i = 0; i < given; i++) v[i] = Number(parts[i]);
  /** The first version past the partial: `3` → 4.0.0, `3.1` → 3.2.0, `3.1.2` → 3.1.3. */
  const next = (n: number): Triple =>
    n === 1 ? [v[0] + 1, 0, 0] : n === 2 ? [v[0], v[1] + 1, 0] : [v[0], v[1], v[2] + 1];
  switch (op) {
    case '=':
      return { lo: v, hi: next(given) };
    case '>=':
      return { lo: v };
    case '>':
      return given === 3 ? { lo: v, loExclusive: true } : { lo: next(given) };
    case '<':
      return { hi: v };
    case '<=':
      return given === 3 ? { hi: v, hiInclusive: true } : { hi: next(given) };
    case '~':
      return { lo: v, hi: given === 1 ? next(1) : next(2) };
    default: {
      // ^ — the left-most non-zero part may not change.
      if (v[0] > 0 || given === 1) return { lo: v, hi: next(1) };
      if (v[1] > 0 || given === 2) return { lo: v, hi: next(2) };
      return { lo: v, hi: next(3) };
    }
  }
}

function within(v: Triple, b: Bound): boolean {
  if (b.lo) {
    const c = cmp(v, b.lo);
    if (c < 0 || (c === 0 && b.loExclusive)) return false;
  }
  if (b.hi) {
    const c = cmp(v, b.hi);
    if (c > 0 || (c === 0 && !b.hiInclusive)) return false;
  }
  return true;
}

/**
 * Whether `version` satisfies an npm-style `range` — the subset extension
 * compatibility needs: comparators `>= > <= < =`, `^`, `~`, partial versions
 * (`>=3.0 <4`), wildcards (`3.x`, `*`), space for AND, `||` for OR.
 *
 * A pre-release counts as its release, so `3.0.0-rc.3` satisfies `>=3.0 <4`
 * (and `4.0.0-rc.1` does not satisfy `<4`). Throws on an invalid version or range.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const v = releaseTriple(version);
  if (!v) throw new Error(`Invalid version: "${version}"`);
  const sets = range
    .replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1')
    .split('||')
    .map((set) => set.trim().split(/\s+/).filter(Boolean));
  if (sets.every((set) => set.length === 0) && range.trim() !== '')
    throw new Error(`Invalid version range: "${range}"`);
  return sets.some((set) => set.map(parseComparator).every((bound) => within(v, bound)));
}
