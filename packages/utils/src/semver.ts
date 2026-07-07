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
