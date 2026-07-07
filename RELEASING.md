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

### Publishing stable artifacts — the tag→`release.yml` trigger needs a PAT

Step 4 only fires automatically if release-please tags with a **PAT**. A tag created
by the default `GITHUB_TOKEN` does **not** cascade to trigger `release.yml` (GitHub's
recursion guard). Add a fine-grained PAT with **contents: write** + **pull-requests:
write** as the `RELEASE_PLEASE_TOKEN` secret — release-please uses it
(`secrets.RELEASE_PLEASE_TOKEN || GITHUB_TOKEN`) and step 4 becomes hands-off.

**Without the PAT**, the Release + tag are still created, but you must publish the
stable image + browser zip by re-pushing the tag from a machine with normal push
rights (a `GITHUB_TOKEN`-free push *does* cascade):

```bash
git push origin :refs/tags/vX.Y.Z && git push origin vX.Y.Z  # re-push → fires release.yml
gh release edit vX.Y.Z --draft=false --latest                # deleting a tag drafts its Release; re-publish it
```

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

### Mobile → fingerprint CD (OTA update / store build → TestFlight)

`.github/workflows/mobile.yml` continuously deploys the Expo app on every `main`
push that touches `apps/mobile/` — still decoupled from the product tag
(app-store cadence). It uses
`expo/expo-github-action/continuous-deploy-fingerprint`, which splits per native
fingerprint:

- **JS/asset-only change** (fingerprint matches an existing EAS build) →
  `eas update` on the `production` branch: an OTA update users receive on their
  next app launch — no store round-trip. `app.json` pins
  `runtimeVersion.policy: "fingerprint"`, so an update can never reach a binary
  it isn't compatible with.
- **Native change** (new fingerprint: native dep / config plugin / SDK bump) →
  `eas build --profile production --auto-submit`: iOS uploads to **TestFlight**
  automatically (internal testers install right away; the final "Submit for App
  Review" click stays manual in App Store Connect), then the update is published
  for the new fingerprint. `buildNumber`/`versionCode` auto-increment **remotely**
  (`eas.json` `appVersionSource: "remote"` — required on CI, where a locally
  bumped number would be thrown away with the checkout).
- **Manual lane**: `workflow_dispatch` with `profile: preview` (internal
  distribution, Android APK) and a `platform` picker (`ios` default; switch to
  `all` once Play credentials exist).

**Fork-safe:** without the `EXPO_TOKEN` secret the workflow no-ops green.

One-time setup (secret-gated, not code — the workflow stays a no-op until done):

1. `cd apps/mobile && eas init` (links the Expo project, writes
   `extra.eas.projectId`), then `eas update:configure` (writes `updates.url`).
   Commit both `app.json` changes.
2. Seed iOS credentials + the App Store Connect app record with one interactive
   run: `eas build --profile production --auto-submit`. This stores the
   distribution cert, the provisioning profile (incl. the App Group
   entitlement), and the ASC API key on EAS servers, and initializes the remote
   `buildNumber`.
3. In the Expo dashboard set the `production` environment variable
   `EXPO_PUBLIC_API_BASE_URL` — the app bakes it in at build/export time (until
   runtime workspace-picker login lands). The workflow passes
   `environment: production` so both builds and updates pick it up.
4. Add an Expo access token as the `EXPO_TOKEN` Actions secret.
5. Android, later: the **first** Play Console upload is manual (store policy);
   after that, add the Play service-account key to EAS and use
   `platform: android`/`all`.

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
- **Mobile one-time setup** — the fingerprint CD workflow (`mobile.yml`) is live
  but no-ops until the steps in "Mobile → fingerprint CD" above are done
  (`eas init`, credential seeding, `EXPO_TOKEN`). Android additionally needs the
  first manual Play Console upload.
- **`release/x.y` maintenance branches** for back-porting security fixes to old
  lines (only once we support more than the latest).
