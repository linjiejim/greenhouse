# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0](https://github.com/linjiejim/greenhouse/compare/v1.0.0...v1.1.0) (2026-09-15)


### Added

* **web:** extension page aliases replace the hard-coded legacy redirects ([e6c89dd](https://github.com/linjiejim/greenhouse/commit/e6c89dd4ac7e4115f623a3ab7afb154646f29fc6))


### Fixed

* **extensions:** refuse a tool core could never build; hand lazy tools the unattended flag ([4d3364c](https://github.com/linjiejim/greenhouse/commit/4d3364c7d6b3f2cf92cff544d12cd873567b4a66))
* **mission:** hand the relay's per-model output caps to the sandbox runner ([acd4914](https://github.com/linjiejim/greenhouse/commit/acd49149f12b50347f573f1f2d2572d5fc58ac83))
* **mission:** stop retrying containment when there is no docker CLI at all ([d9676ed](https://github.com/linjiejim/greenhouse/commit/d9676edb4797dde0be0c0d514efe333920808c8b))
* **web:** give extension administration modules core's `admin.<key>` id ([399222b](https://github.com/linjiejim/greenhouse/commit/399222ba69a5376683fadb2492cc20db4c2efd79))

## [1.0.0](https://github.com/linjiejim/greenhouse/compare/v0.6.0...v1.0.0) (2026-09-14)


### ⚠ BREAKING CHANGES

* **db:** the public /api/v1 surface, guest accounts and the database-managed LLM gateway upstreams are removed; models come from apps/api/src/config/models.yaml.

### Added

* **agent-core:** env-derived registry, provider quirks and run guarantees ([3e59338](https://github.com/linjiejim/greenhouse/commit/3e593389f87286f9d9e56822897629ac46b1c11c))
* **agent-runner:** mission sandbox runner image ([722ae65](https://github.com/linjiejim/greenhouse/commit/722ae6558aeb1eb916df91985cce5265438eeebf))
* **api:** extension seam — one object per extension, aggregated into every registry ([38182a4](https://github.com/linjiejim/greenhouse/commit/38182a4b73870a5c8c8bb03c9b44e3e9085c877c))
* **api:** platform kernel host, tables, runtime kernel, missions and integrations ([6d38b37](https://github.com/linjiejim/greenhouse/commit/6d38b3771d2a99610e2deaf483da4a5ee6234089))
* **cli:** db baseline --through stops short of the end of a chain ([cb3ef52](https://github.com/linjiejim/greenhouse/commit/cb3ef5284b5b778f9c52aa0c91d5a2b4862098ac))
* **cli:** db baseline refuses to record migrations whose tables are absent ([3a7e24b](https://github.com/linjiejim/greenhouse/commit/3a7e24bd62abe13dbf7b5a5d8e07fd0d6c111c38))
* **clients:** typed station config with a single-station lock ([a5162be](https://github.com/linjiejim/greenhouse/commit/a5162be4efcef2e0bfb45be167796257241301bf))
* **config:** typed greenhouse.config.ts, validated at boot ([364d004](https://github.com/linjiejim/greenhouse/commit/364d004adab26ad34812cb30a54b4a5770c80c77))
* **crud,ui,knowledge-editor:** interaction standard and editor updates ([33b8fa2](https://github.com/linjiejim/greenhouse/commit/33b8fa25115a63e21217f339bf4e497c482e1af2))
* **db:** extension services, reset tables and a checksummed migration lane ([295275c](https://github.com/linjiejim/greenhouse/commit/295275c8e094661adb93ff0e215560e65947a240))
* **db:** platform-line schema, services and migration 0006 ([9ecd463](https://github.com/linjiejim/greenhouse/commit/9ecd46398570d5de32977973b30db474f9ed7112))
* **drive:** extensions can own a drive scope ([3a3cc04](https://github.com/linjiejim/greenhouse/commit/3a3cc0443be429da484715859e46f231bd795654))
* **extensions:** declare a dependency on another extension ([a2458a3](https://github.com/linjiejim/greenhouse/commit/a2458a3c63f9dd595b25350c755c2a5aa0c68b68))
* **extensions:** export sources and application-backed tool visibility ([a7508cf](https://github.com/linjiejim/greenhouse/commit/a7508cf2bc95ec551cbfe78df51e066b83f45d19))
* **extensions:** open the last four shared registries — record kinds, search, MCP groups, workbench cards ([80d299b](https://github.com/linjiejim/greenhouse/commit/80d299bd688ed925926a4b4bf2a71b70c333f789))
* **platform-kernel:** manifest v2, actor context, authorization and registry ([f00c371](https://github.com/linjiejim/greenhouse/commit/f00c371466c62c6d400b5fe266da5fac9d05f9b9))
* **platform:** applications declare which entities the team role may export ([aa058f1](https://github.com/linjiejim/greenhouse/commit/aa058f159ebae6352293c8881258cbd0a5bcc9a0))
* **scripts:** screenshot tour that doubles as a browser smoke test ([7f863fa](https://github.com/linjiejim/greenhouse/commit/7f863fae216f685cb6e43d296e25515a3c009f7a))
* **skills:** first-party skill pack directory and sync script ([e773f66](https://github.com/linjiejim/greenhouse/commit/e773f66da558a86cdf750e4915aa13948a9a9d9e))
* **types,utils:** shared registries and helpers for the platform line ([2e22e7c](https://github.com/linjiejim/greenhouse/commit/2e22e7c625995e448cfa9c43f2bbce07a1a78625))
* **web:** extension pages can declare their own sub-modules ([5821770](https://github.com/linjiejim/greenhouse/commit/58217705a4ff7b91a5fe927133d374c31b3648d6))
* **web:** extension seam — pages, navigation, modules, copy, cards and agent context ([8ab9224](https://github.com/linjiejim/greenhouse/commit/8ab92243a2c5178745c082ad06dc0e7cc5004411))
* **web:** platform catalog shell, tables, execution center and chat upgrades ([3089011](https://github.com/linjiejim/greenhouse/commit/30890118c1873ddd2d87ee68ba12b4a96b13d570))


### Fixed

* **agent-core:** guarantee a final assistant answer when tool loops end with no text ([#21](https://github.com/linjiejim/greenhouse/issues/21)) ([14ff075](https://github.com/linjiejim/greenhouse/commit/14ff0750dd314ac977d91e8480580e363f17c5a6))
* **build:** the web build failed in a clean environment ([f56a607](https://github.com/linjiejim/greenhouse/commit/f56a6073d66b3a08dbd1207aa3ef4af6800b4c4b))
* **cli:** baseline's table check has to net creates against later drops ([77d8222](https://github.com/linjiejim/greenhouse/commit/77d8222b7a73c32cb54ea4393e2552ed3f10a8be))
* **cli:** db baseline took its confirmation arguments in the wrong order ([5b2322f](https://github.com/linjiejim/greenhouse/commit/5b2322f927d87867c1330aeff9c83bc0b95134bb))
* **drive:** folder creation dropped the extension owner key ([436d2cf](https://github.com/linjiejim/greenhouse/commit/436d2cf4b343afa7fbd95cbac5541e260e6328bb))
* **extensions:** type userRole on the search and drive seam contexts ([d1a7a6b](https://github.com/linjiejim/greenhouse/commit/d1a7a6bb74f59deaaa9c896d400ff15b9d38c9ff))
* **lint:** pin the typescript-eslint project root ([90d04e4](https://github.com/linjiejim/greenhouse/commit/90d04e45973e76194d1344ff3820a6225d12c1f7))
* **platform:** derive application gating from the feature-point registry ([d3b13af](https://github.com/linjiejim/greenhouse/commit/d3b13afe916ccebcca7fd47ceb041e12bc85b2be))
* remove the strings, helpers and navigation left behind by the private modules ([865af69](https://github.com/linjiejim/greenhouse/commit/865af697dc9f1565c84a901148b5409bd9b14d32))
* **scripts:** the overlay guard's ** only matched one directory level ([aa28f08](https://github.com/linjiejim/greenhouse/commit/aa28f0865aa7df5550cbf9c4bc2fe4adb1e8ab30))
* **seed:** drop the retired read_at field from session shares ([d0f4f8d](https://github.com/linjiejim/greenhouse/commit/d0f4f8d37dd868d5451410ffcaf448e63635a924))
* **web:** keep chat header actions clear of the title on phones ([58d6a7f](https://github.com/linjiejim/greenhouse/commit/58d6a7f7a01be2f03d9b679cc94358c3ad677977))
* **web:** localized automation times, plain-text inbox previews, wrapping MCP scopes ([1f35dbf](https://github.com/linjiejim/greenhouse/commit/1f35dbfb4522abe29169fa036e0e9368b40cca6a))


### Changed

* **api:** group the flat domain files into chat/, knowledge/, profiles/, security/, sessions/ and drive/ ([d6edeb4](https://github.com/linjiejim/greenhouse/commit/d6edeb43206f4e55eaf8c03c32b5872b0ca18d1a))
* release 1.0.0 ([91f7850](https://github.com/linjiejim/greenhouse/commit/91f78509824c40673e569c5a7ca5afe44845d942))
* **tests:** move the loose test files under tests/api and refresh doc paths ([fede0fa](https://github.com/linjiejim/greenhouse/commit/fede0fa1e785190a58e61d49cdc2e3010ed3942a))
* **web:** administration panels under pages/administration, executions/ and top-level tasks/automations ([2a841e9](https://github.com/linjiejim/greenhouse/commit/2a841e9c1bfc24d2b2aaea6a8a2d253c3d6d6668))

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
