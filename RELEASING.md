# Releasing Greenhouse

Greenhouse is one product with one version. Tags identify published releases; version fields
across root, apps, packages, plugins, Expo and desktop mirror that version. The Release PR
normally updates them through `release-please-config.json` extra-files. The authorized local
4.0.0-rc.1 cut is prepared in this checkout; **no tag or artifact is created by changing these files**.

## Channels and artifacts

| Ref | Workflow output | Intended use |
|---|---|---|
| Stable `vX.Y.Z` | GHCR `:X.Y.Z`, `:X.Y`, `:latest` | Stable, preferably exact-version pinned |
| Candidate `vX.Y.Z-rc.N` | GHCR exact `:X.Y.Z-rc.N` only | Acceptance testing |
| `main` | GHCR `:edge`, `:main-<sha>` | Continuous unstable integration |

`.github/workflows/release.yml` uses `docker/metadata-action` with `latest=auto`; prereleases
must not move stable aliases. The image currently builds linux/amd64. It includes both classic
and universal web exports; the API serves them. Desktop artifacts are not built/published by
this workflow. Mobile has a separate fingerprint CD workflow, not a product-tag release job.

APP_VERSION/APP_REVISION build arguments become image env and OCI labels. Extension compatibility
uses a valid APP_VERSION or falls back to root package.json for unstamped development builds.
`GET /health` reports health/runtime switches; it does **not** return version or revision.
Verify the image labels/config with `docker inspect`.

## Candidate version automation

The checked-in candidate settings are:

```json
{
  "release-type": "node",
  "versioning": "prerelease",
  "prerelease": true,
  "packages": { ".": { "prerelease-type": "rc" } }
}
```

`versioning` selects the increment strategy; `prerelease` also marks the GitHub release and
keeps the suffix; `prerelease-type` selects rc in the root package configuration (the schema allows it
there, not as a top-level property). See the upstream
[manifest settings](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md)
and [versioning strategy](https://github.com/googleapis/release-please/blob/main/src/versioning-strategies/prerelease.ts).
For this 4.0.0-rc.1 baseline, fix/feature/breaking increments all yield 4.0.0-rc.2. With the
prerelease strategy retained and `prerelease: false`, those increments produce 4.0.0 instead.
Do not switch to the default strategy during promotion and accidentally advance the base version.

The manifest now records 4.0.0-rc.1. It is a local prepared baseline until that exact candidate
is published. A new automated Release PR would propose the *next* candidate; it is not the
way to publish these already-written rc.1 notes.

extra-files updates every app/package/plugin package.json, Expo app.json, Tauri config,
Cargo.toml and only the greenhouse-desktop package version in Cargo.lock. The Cargo.lock
JSONPath inspects the TOML updater's `name.value` node; this target was exercised with the
actual release-please updater and leaves dependency versions/checksums untouched.

## Publishing the prepared rc.1 (operator: Jim)

These are operator instructions, not actions performed by this documentation task.

1. Review/land the complete candidate, including version targets, migration ownership and the
   release notes. Confirm all required gates plus actual classic/universal browser acceptance;
   run the seeded screenshot tour on a host where Chromium launches. Exercise the 3.x upgrade
   on a backup copy with the intended plugin list.
2. Review `.github/workflows/mobile.yml` **before landing mobile version changes on main**.
   It can deploy to the production EAS branch on a main push when EXPO_TOKEN exists. Product
   rc tagging does not gate that lane; pause/configure it operationally if store/OTA publication
   is not intended. Do not run EAS publication commands as part of a local rc cut.
3. Select the exact accepted commit and verify no `v4.0.0-rc.1` tag/release already exists.
   Create and push that annotated tag from the accepted revision, then create a GitHub release
   marked prerelease, explicitly not latest. Use only the rc.1 section of CHANGELOG as its notes.

   ```bash
   # Run only after acceptance, with <accepted-sha> replaced by the reviewed commit.
   git tag -a v4.0.0-rc.1 <accepted-sha> -m 'Greenhouse 4.0.0-rc.1'
   git push origin refs/tags/v4.0.0-rc.1
   # Put just the rc.1 release notes in /tmp/greenhouse-rc-notes.md first.
   gh release create v4.0.0-rc.1 --verify-tag --prerelease --latest=false \
     --title 'Greenhouse 4.0.0-rc.1' --notes-file /tmp/greenhouse-rc-notes.md
   ```

4. Watch the Release workflow; inspect the exact rc image's APP_VERSION/revision/OCI labels
   and confirm stable aliases did not move. Deploy the pinned rc only to the intended test
   environment and verify login, plugin status, default/off behavior and both hosting modes.
5. Publish a signed/notarized desktop build only through the separate
   [desktop runbook](apps/desktop/README.md). Native iOS/Android distribution is also separate;
   use a valid store version/profile when required by the store rather than assuming a SemVer
   prerelease suffix is accepted by a store submission.

Do not delete/recreate an existing release tag to force a build. The current Release workflow
has no workflow_dispatch trigger. If a token-created tag did not trigger it, add/review an explicit
workflow publication path or create the release tag with normal operator/PAT credentials in the
first place; never silently rewrite a published tag.

## Next candidate and stable promotion

For another rc, keep the candidate settings, land Conventional Commits and review the next
Release PR. release-please normally runs on main; merge its PR only when that next candidate
is intended. RELEASE_PLEASE_TOKEN (contents/PR write) lets its tag push trigger release.yml;
GITHUB_TOKEN-created tags do not cascade to another workflow. Inspect workflow execution.

To release **4.0.0 stable**, set `prerelease: false`, keep `versioning: 'prerelease'` for the
promotion PR, remove `prerelease-type` if desired, and explicitly set package `release-as:
'4.0.0'` if an exact promotion needs pinning. Review the proposed version and stable release
flag before merging. After stable is published, remove release-as and prerelease-type, set
`versioning: 'default'`, and leave `prerelease: false` for normal SemVer (breaking/feat/fix →
major/minor/patch). A persistent release-as would keep proposing the same version.

Do not edit prior released CHANGELOG sections. Squash PRs with Conventional Commit titles;
release-please maintains the next notes and all version targets. Independent manifest schema
versions inside platform application definitions are contracts, not product version fields.

## Mobile fingerprint CD

`mobile.yml` runs on main changes under apps/client and manual dispatch, repository-gated and
EXPO_TOKEN-gated. Its default profile is production and platform is iOS. A matching native
fingerprint publishes OTA; a new fingerprint builds and explicitly submits iOS to TestFlight.
Version fields are excluded from the native fingerprint, so version-only edits can still enter
the OTA lane. Store review is manual. Android needs its first store upload/credentials and
push configuration before distribution claims are made.

The EAS project, identifiers and update URL are shared with existing installations. Keep those
identities unchanged and use dedicated development/preview builds for acceptance. Native
buildNumber/versionCode are remotely incremented and separate from the product version.
Signing secrets remain outside the repository; do not infer permission to publish from tests.

## Release verification

- Run typecheck/lint, strict overlay/package guards, sync check, full unit/DB/committed-state
  tests, HTTP security, zero-package core boot, mobile typecheck/lint and web builds.
- Run actual classic/plugin and universal Playwright in a Chromium-capable environment;
  collect-only results are insufficient. Regenerate public captures with real seeded UI.
- Verify 3.x data preservation and explicit retained plugin enablement; migrations run before
  API startup. Backups use scripts/backup-db.sh; do not use push on persistent/shared DBs.
- Keep the prior image/config and DB backup for rollback; code downgrade is not reverse migration.
- Require repository branch protections and squash merges; upstream workflows remain gated to
  the upstream repository, forks own fork-*.yml.
