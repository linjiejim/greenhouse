# Releasing Greenhouse

Maintainer runbook. Greenhouse ships as **one product** at **one version** — there
is no per-package release. `git tag vX.Y.Z` is the single source of truth for
"what is a release"; the **root `package.json` `version`** is kept in sync with it
automatically by release-please (`release-type: node`) — it records the current
release, so **don't hand-edit it**. The per-workspace `package.json` `version` fields
are placeholders (not maintained). The runtime version still comes from the tag,
injected as `APP_VERSION` (see below), not read from `package.json`.

## Stable vs. edge — the promise

| Channel | What it is | Where | Stability |
|---|---|---|---|
| **Tagged release** `vX.Y.Z` | A cut we stand behind | GitHub Releases; GHCR `:X.Y.Z`, `:X.Y`, `:latest` | **Stable** |
| **`main` HEAD** | Continuous integration | GHCR `:edge`, `:main-<sha>` | **Unstable** — may break between releases |
| **Pre-release** `vX.Y.Z-rc.N` | Release candidate | GitHub Release marked "pre-release"; GHCR `:X.Y.Z-rc.N` | Testing only |

`:latest` **always points at the newest stable, non-prerelease tag — never at
`main`.** Production deploys should pin a `:X.Y.Z` (or track `:X.Y`). `:edge` is
for people who want to test the tip and understand it can break.

## Version strategy

- **SemVer**, pre-1.0 (`0.y.z`): while `0.x`, a `feat:` bumps the **minor** and
  `fix:` bumps the **patch** (breaking changes also bump minor until 1.0). This is
  configured in `release-please-config.json` (`bump-minor-pre-major`).
- **Conventional Commits drive the bump.** The repo already uses them
  (`feat(api:export): …`, `fix(web): …`). PRs are **squash-merged** so one PR =
  one Conventional Commit on `main`.
- **Mobile is decoupled.** The Expo app follows app-store cadence with its own
  `version` + `buildNumber`/`versionCode` (`apps/mobile/app.json`, `eas.json`
  `autoIncrement`). It does not have to match the product version.

## How a release happens (the automated flow)

1. **Merge PRs to `main`.** Each squash-merged PR is a Conventional Commit.
2. **release-please opens/updates a "Release PR"** (`.github/workflows/release-please.yml`).
   It computes the next SemVer from the commits and regenerates the `CHANGELOG.md`
   entry. Review it like any PR.
3. **Merge the Release PR.** release-please tags `vX.Y.Z` and creates the GitHub
   Release with the generated notes.
4. **The tag triggers `.github/workflows/release.yml`**, which builds & publishes:
   - the **container image** to `ghcr.io/<owner>/greenhouse` (`:X.Y.Z`, `:X.Y`,
     `:latest`), stamped with `APP_VERSION`/`APP_REVISION` + OCI labels;
   - the **browser extension zip** `greenhouse-bridge-vX.Y.Z.zip`, attached to the
     Release.
   The source tarball is attached automatically by GitHub.

Pushes to `main` (no tag) run the same `release.yml` but only publish the `:edge` /
`:main-<sha>` image — never `:latest`, never a Release asset.

### Cutting a pre-release

Land the commits, then let release-please propose the version; to force an `-rc`,
add a `Release-As: X.Y.Z-rc.1` trailer to a commit (release-please convention).
Mark the GitHub Release as a pre-release. The `:latest` tag is intentionally
skipped for any tag containing a `-` (prerelease).

## Verifying the version stamp

Every image knows which code it is:

```bash
docker run --rm ghcr.io/<owner>/greenhouse:X.Y.Z \
  node -e "fetch('http://localhost:3000/health')"   # or hit /health once up
curl -s localhost:3000/health | jq '{version, revision}'
docker inspect ghcr.io/<owner>/greenhouse:X.Y.Z --format '{{json .Config.Labels}}'
```

`/health` returns `version` (the tag) + `revision` (the commit sha), sourced from
`@greenhouse/utils/version` (`APP_VERSION` / `APP_REVISION`). A downloader filing a
bug can paste those two fields and we can reproduce against the exact commit.

## Artifact pipelines

### API + web → container image (primary artifact)

The whole app is one deployable unit (the API serves the built SPA), so the
"standard package" is the **container image**. `release.yml` builds it with
`docker/build-push-action`, tags via `docker/metadata-action`, and pushes to
**GHCR** (public, free, GitHub-native auth). `docker compose up` consumes it.

### Browser extension → versioned zip

`pnpm --filter @greenhouse/browser package` runs `vite build`, stamps
`dist/manifest.json` `version` from `APP_VERSION` (normalised to Chrome's numeric
form — `v0.2.0-rc.1` → `0.2.0`), and zips `dist/` into
`greenhouse-bridge-v<version>.zip` for "Load unpacked" / Web Store submission.

### Mobile → EAS Build

`apps/mobile/eas.json` defines `development` / `preview` / `production` profiles.
For testers, `eas build --profile preview` produces an installable APK / simulator
build. `production` uses `autoIncrement` for store `buildNumber`/`versionCode`. Full
store automation needs an Expo account + credentials (see Follow-ups). The mobile
release runs on its own cadence, decoupled from the product tag.

## Branch protection (GitHub setting — record only)

`main` is the integration branch (trunk). Configure in repo **Settings → Branches**:

- Require a pull request before merging, **≥ 1 approving review**.
- Require status checks to pass: the `Quality gate` jobs (lint, typecheck, test,
  e2e, secret-scan).
- **Squash merge only** (keeps one Conventional Commit per PR for release-please).
- Include administrators.

## Follow-ups (need external accounts / credentials — not code-only)

- **Multi-arch images** (`linux/arm64`): verify the `compute` tool's `isolated-vm`
  native addon cross-compiles under buildx + QEMU, then add the platform in
  `release.yml`. Currently **amd64 only**.
- **Supply-chain hardening**: SBOM (`anchore/sbom-action` / buildx `--sbom`),
  provenance attestation (`--provenance`), `cosign` keyless signing (OIDC).
- **Chrome Web Store auto-publish** (`chrome-webstore-upload-action`) — needs store
  credentials as secrets (`STORE-SUBMISSION.md` has the copy ready).
- **EAS Submit** store automation — needs an Expo token + store credentials.
- **`release/x.y` maintenance branches** for back-porting security fixes to old
  lines (only once we support more than the latest).
