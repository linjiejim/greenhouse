/**
 * Convert a release tag/version into a Chrome extension manifest version.
 *
 * Chrome requires `version` to be 1–4 dot-separated integers (no `v` prefix, no
 * `-rc.1` prerelease / `+build` metadata). The release tag can be anything
 * SemVer, so `v0.2.0-rc.1` → `0.2.0`. Returns `null` for empty/unusable input so
 * callers keep the version already baked into public/manifest.json (a plain
 * `pnpm build` with no APP_VERSION doesn't restamp).
 */
export function toManifestVersion(raw) {
  if (!raw) return null;
  const core = String(raw).trim().replace(/^v/i, '').split(/[-+]/)[0];
  const parts = core
    .split('.')
    .filter((p) => /^\d+$/.test(p))
    .slice(0, 4);
  return parts.length ? parts.join('.') : null;
}
