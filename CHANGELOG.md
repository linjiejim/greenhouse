# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

> From here on, this changelog is maintained by [release-please](https://github.com/googleapis/release-please)
> from Conventional Commits. See [RELEASING.md](./RELEASING.md).

### Added

- Release engineering: automated versioning via release-please (Release PR → tag →
  GitHub Release), and a tag-triggered `release.yml` that publishes the container
  image to GHCR (`:X.Y.Z`/`:X.Y`/`:latest` for stable; `:edge`/`:main-<sha>` for
  `main`) and attaches the browser extension zip to the Release.
- `RELEASING.md` maintainer runbook; README "Releases & stability" section + latest-release
  badge; `SECURITY.md` supported-versions table.
- Build version stamp: `Dockerfile` takes `APP_VERSION`/`APP_REVISION` (+ OCI labels)
  and `GET /health` now returns the running `version` + commit `revision`.
- `apps/mobile/eas.json` (EAS Build profiles) + `runtimeVersion` policy for the Expo app.
- Browser e2e suite (Playwright) in `tests/e2e-ui/` — `pnpm test:e2e:ui`. Deterministic
  Chromium specs for login, chat (LLM stubbed), project create, and user create/delete.
- `data-testid` anchors on the login / chat / projects / users surfaces and `role="dialog"`
  on `<Dialog>` / `<ConfirmDialog>` for stable test/automation locators.
- Open-source project files: `CODE_OF_CONDUCT.md`, issue & pull-request templates, this
  changelog.

### Fixed

- `DELETE /api/admin/users/:id` returned 500 on a successful delete. `users.delete` checked
  `result.rowCount`, which the postgres-js driver does not populate; switched to the
  codebase-standard `.returning()` + length check.

## [0.1.0]

- Initial release.
