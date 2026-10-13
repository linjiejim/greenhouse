---
name: add-frontend-page
description: >-
  Add a page to the Greenhouse web app (apps/web): a Settings or Administration panel, a CRUD
  list, or a standalone page, with nav registration, mounting, typed API calls, i18n and checks.
  Use for 加个页面 / 新增前端页面 / 做个新界面 / 加个设置页 / 加个管理页 / 加后台页面 /
  add a web page / add a settings page / add an admin page.
---

Rules live in apps/web/src/AGENTS.md. Copy apps/web/src/pages/settings/email-accounts.tsx (CRUD list) or apps/web/src/pages/settings/preferences.tsx (form), and apps/web/src/lib/api/email.ts for the calls.

Before you start:
- Check the feature's row in docs/product/features.md; never extend a module marked 删除 or 合并.
- A private or optional module's page belongs in an extension (apps/web/src/extensions/example/).
- The endpoint exists; otherwise run the add-api-route skill first.
- Reuse what apps/web/src/components/ and the design preview page (#/design) already offer.
- Choose the place: personal settings in pages/settings/, super-only management in pages/administration/, a workspace page of its own in pages/.

Steps:
1. Build the page with `<ModulePage moduleId="..." layout="...">` (components/app/module-page.tsx) as its root; layout is form, list or canvas.
2. For lists and records use defineCrud and CrudPage from pages/settings/crud.ts, and declare canAdd, canEdit and canDelete for every write (they default to false).
3. Register the module in apps/web/src/lib/nav-registry.ts: SETTINGS_TOP or SETTINGS_LABS (id `settings.<key>`), ADMINISTRATION_MODULES (id `admin.<key>`, requireRole super) or STANDALONE_MODULES (id `workspace.<key>`); add requireFeature when a flag gates it.
4. Add its NAV_COPY entry in nav-registry.ts and every new string to lib/i18n/en.ts and zh.ts.
5. Mount a panel with an import and a render line in pages/settings/index.tsx or pages/administration/index.tsx.
6. Mount a standalone page in app.tsx (lazy import, Route union, CORE_ROUTES, render branch) and give it an entry point, such as the More menu in platform/navigation.ts.
7. Call the API from a `lib/api/<domain>.ts` module on rpc (lib/api/client.ts); streaming and FormData endpoints use authFetch.
8. Add the page to MODULE_PAGES in apps/web/src/pages/settings/module-page-coverage.test.ts; give a CRUD schema a testId for Playwright specs in tests/e2e-ui/.
9. Check it in a browser (`pnpm dev` and open :3100, or `pnpm run-dev up` in a worktree): desktop and 375px, light and dark, deep link, refresh and back.
10. Run the quality-gate skill; rerun `node scripts/capture-screens.mjs` for a visible change.
11. If the change ships or removes a feature, set its row in docs/product/features.md (status and PR) in the same PR.

v2: the v2 web is rebuilt on packages/ui following docs/design-system (roadmap M1 to M3); keep v1 pages on v1 conventions and do not mix in v2 tokens or patterns.
