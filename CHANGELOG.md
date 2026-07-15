# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.1](https://github.com/linjiejim/greenhouse/compare/v0.6.0...v0.6.1) (2026-07-15)


### Fixed

* **agent-core:** guarantee a final assistant answer when tool loops end with no text ([#21](https://github.com/linjiejim/greenhouse/issues/21)) ([14ff075](https://github.com/linjiejim/greenhouse/commit/14ff0750dd314ac977d91e8480580e363f17c5a6))

## [0.6.0](https://github.com/linjiejim/greenhouse/compare/v0.5.0...v0.6.0) (2026-07-09)


### Added

* **crud:** unify settings admin pages on @greenhouse/crud ([#18](https://github.com/linjiejim/greenhouse/issues/18)) ([b207c1b](https://github.com/linjiejim/greenhouse/commit/b207c1b916d6db35050a813a1553f5eeba556fb5))
* **workspace:** admin-editable branding, runtime keys & Sprouty DSL ([#11](https://github.com/linjiejim/greenhouse/issues/11)) ([80b5b3e](https://github.com/linjiejim/greenhouse/commit/80b5b3ebbb86e3b3b90b4dbd238149285e66fe14))


### Fixed

* **db:** bump renumbered workspace_settings migration timestamp so migrated databases apply it ([7093c70](https://github.com/linjiejim/greenhouse/commit/7093c70c21f7971e6f9d042f056b90711d1ce083))

## [0.5.0](https://github.com/linjiejim/greenhouse/compare/v0.4.0...v0.5.0) (2026-07-08)


### Added

* **mobile:knowledge:** native editing, version history, scope tabs ([0a33de6](https://github.com/linjiejim/greenhouse/commit/0a33de61f4b026bc5cd69caa20ae1811daa23041))
* **mobile:projects:** project management — list, board, touch-native gantt ([#16](https://github.com/linjiejim/greenhouse/issues/16)) ([e57fbf9](https://github.com/linjiejim/greenhouse/commit/e57fbf9e774b3b5183fef87fa6b261b2a3e864c3))


### Fixed

* **mobile:sheet:** never let the keyboard push sheets off-screen ([31b5e3e](https://github.com/linjiejim/greenhouse/commit/31b5e3e569c4958bf58da2beac3e030c942e51a2))

## [0.4.0](https://github.com/linjiejim/greenhouse/compare/v0.3.0...v0.4.0) (2026-07-08)


### Added

* **mobile:** app icon — greenhouse logo (iOS + Android adaptive) ([0bd11dc](https://github.com/linjiejim/greenhouse/commit/0bd11dc67abb0b9d236eb4c3d3319a6969eb3640))
* **mobile:** chat & nav polish — smooth stream reveal, one-row composer, station switcher in drawer ([ff49924](https://github.com/linjiejim/greenhouse/commit/ff4992427a96a00f5658e6161591fe52202e14f5))

## [0.3.0](https://github.com/linjiejim/greenhouse/compare/v0.2.0...v0.3.0) (2026-07-07)


### Added

* **api&web:skills:** add Skill Center for skill sharing & sync ([3cbcccb](https://github.com/linjiejim/greenhouse/commit/3cbcccbf6fd7075ddc4b4fdeea13f3fc09e00470))
* **browser&mobile:stations:** connect to multiple self-hosted servers ([a196615](https://github.com/linjiejim/greenhouse/commit/a196615cd44bb38dce94f0b1b4ac13eaa7fa91be))
* **release:** mobile fingerprint CD + pull-based GHCR compose upgrade ([6188c45](https://github.com/linjiejim/greenhouse/commit/6188c45f932a39302333249b5f65fc9243dfb5d3))


### Fixed

* **ci:** pin continuous-deploy-fingerprint to a main sha ([266117a](https://github.com/linjiejim/greenhouse/commit/266117af52a3544e830758f44eae4dcbadd4dace))
* **ci:** submit new mobile store builds to TestFlight explicitly ([dd1f52e](https://github.com/linjiejim/greenhouse/commit/dd1f52e874021fdcfe01eb6438078f500c7e5666))
* **mobile:** pin ascAppId so --auto-submit resolves non-interactively ([04e7635](https://github.com/linjiejim/greenhouse/commit/04e76350620b2ba83b6aba0782e5dcde7819fb09))

## [0.2.0](https://github.com/linjiejim/greenhouse/compare/v0.1.0...v0.2.0) (2026-07-06)


### Added

* **release:** standardize release pipeline with version automation, container images, browser packaging, and mobile EAS ([93c295a](https://github.com/linjiejim/greenhouse/commit/93c295a672501b4b7e04c0590f4dca71bbfda436))

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
