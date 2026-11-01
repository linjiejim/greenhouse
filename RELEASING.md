# Releasing Greenhouse

Greenhouse is one product with one version. Tags identify published releases; version fields
across root, apps, packages, plugins, Expo and desktop mirror that version. The Release PR
updates them through `release-please-config.json` extra-files. Changing version files by hand
creates no tag or artifact.

## Channels and artifacts

| Ref | Workflow output | Intended use |
|---|---|---|
| Stable `vX.Y.Z` | GHCR `:X.Y.Z`, `:X.Y`, `:latest` | Stable, preferably exact-version pinned |
| Candidate `vX.Y.Z-rc.N` | GHCR exact `:X.Y.Z-rc.N` only | Acceptance testing |
| `main` | GHCR `:edge`, `:main-<sha>` | Continuous unstable integration |

`.github/workflows/release.yml` uses `docker/metadata-action` with `latest=auto`; prereleases
must not move stable aliases. The image currently builds linux/amd64. It includes the hosted
universal client export (`public/app`, built in its own stage); the API serves it at `/`.
Desktop artifacts are not built/published by this workflow. Mobile has a separate fingerprint CD workflow, not a product-tag release job.

APP_VERSION/APP_REVISION build arguments become image env and OCI labels. Extension compatibility
uses a valid APP_VERSION or falls back to root package.json for unstamped development builds.
`GET /health` reports health/runtime switches; it does **not** return version or revision.
Verify the image labels/config with `docker inspect`.

## Version automation

release-please runs on every push to main and keeps one Release PR open with the next version
and the generated CHANGELOG section. Squash PRs with Conventional Commit titles; breaking,
feat and fix map to major, minor and patch. Merging the Release PR tags `vX.Y.Z` and creates the
GitHub release, which triggers release.yml. RELEASE_PLEASE_TOKEN (contents and PR write) is
needed for that tag to start another workflow; tags made with GITHUB_TOKEN do not cascade.

extra-files updates every app/package/plugin package.json, Expo app.json, Tauri config,
Cargo.toml and only the greenhouse-desktop package version in Cargo.lock. Independent manifest
schema versions inside platform application definitions are contracts, not product versions.

Do not edit released CHANGELOG sections. If `extra-files` changes while a Release PR is open,
close the PR, delete its branch and let release-please regenerate it.

## Release candidates

To cut candidates for the next version, set `versioning: "prerelease"`, `prerelease: true` and
the root package's `prerelease-type: "rc"`, and pin `release-as: "X.Y.Z-rc.1"` for the first one.
Remove release-as after it is tagged; later Release PRs propose the next rc. To promote, set
`prerelease: false` and pin `release-as: "X.Y.Z"` while keeping the prerelease strategy, so the
base version does not advance. After the stable release, remove release-as and prerelease-type
and return to `versioning: "default"`. A persistent release-as keeps proposing the same version.

## Before merging a Release PR

- All CI jobs pass on the Release PR, including client-e2e and deploy smoke.
- The main image (`:main-<sha>` of the same commit) runs on the integration server: `/health`,
  sign-in at `/`, chat, Files, each enabled plugin place, Admin, plugin status
  (`pnpm cli plugins status` or Admin › Plugins) and the entry pages.
- An in-place upgrade from the previous release line on a backup copy keeps its data.
- Release notes call out breaking changes and what `:latest` users get on their next pull.
- Review `.github/workflows/mobile.yml` before version changes land on main: a main push can
  publish OTA or start a TestFlight build when EXPO_TOKEN exists.

After the tag: watch release.yml, check the image's APP_VERSION, revision and OCI labels with
`docker inspect`, and confirm prereleases did not move stable aliases. Never delete or recreate a
published tag to force a build; release.yml has no workflow_dispatch trigger.

Desktop builds are published only through the [desktop runbook](apps/desktop/README.md) (preview
in 4.0). iOS and Android store distribution is separate; store versions do not accept SemVer
prerelease suffixes.

## Mobile fingerprint CD

`mobile.yml` runs on main changes under apps/client and manual dispatch, repository-gated and
EXPO_TOKEN-gated. Its default profile is production and platform is iOS. A matching native
fingerprint publishes OTA; a new fingerprint builds and explicitly submits iOS to TestFlight.
Version fields are excluded from the native fingerprint, so version-only edits can still enter
the OTA lane. The whole `apps/client/targets/` folder (share extension and widget Swift) is hashed,
so a change there always builds. Store review is manual. Android needs its first store upload/credentials and
push configuration before distribution claims are made.

The EAS project, identifiers and update URL are shared with existing installations. Keep those
identities unchanged and use dedicated development/preview builds for acceptance. Native
buildNumber/versionCode are remotely incremented and separate from the product version.
Signing secrets remain outside the repository; do not infer permission to publish from tests.

## Release verification

- Run typecheck/lint (including the plugin boundary scan), `plugins:sync --check`, full
  unit/DB/committed-state tests, HTTP security (`test:e2e:ci`), zero-package core boot
  (`test:core`), client typecheck/lint inside `apps/client` and `pnpm app:build`.
- Run `pnpm test:e2e:client` in a Chromium-capable environment; collect-only results are
  insufficient. Product captures come from real seeded UI, never mocks.
- Verify in-place 3.x data preservation (3.0.2 → 4.0 bridge), the schema-equivalence test and
  explicit retained plugin enablement; migrations run before API startup. Backups use scripts/backup-db.sh; do not use push on persistent/shared DBs.
- Keep the prior image/config and DB backup for rollback; code downgrade is not reverse migration.
- Require repository branch protections and squash merges; upstream workflows remain gated to
  the upstream repository, forks own fork-*.yml.
