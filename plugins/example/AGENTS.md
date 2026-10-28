# Example SDK 2 data plugin

- Shared plugin rules: [root AGENTS.md](../../AGENTS.md) (Plugins) and [EXTENDING.md](../../EXTENDING.md); this file lists only Example-specific rules.
- Preserve `ext_example_notes`, applied migration bytes, legacy notes tools/routes and the `#/example/notes/:id` entity route. Compatibility adapters share the generated application's action guards/audit; their wire response stays unchanged.
- The data declaration owns read/create/update/delete/export, own/userId scope, column mapping, field classification, views, peek and custom search. Do not hand-register duplicate generated tools/routes/search/export entries.
- Exercise stable agent context, resource and prompt, user.created observation, durable welcome notification and onInstall. Hooks are idempotent and metadata-only.
- `manifest.ts` is pure station metadata: an Admin `settings-form` page and an `embed` page. ui/ is a tiny public static frontend with no bundled credentials or private data.
- Only the note body is client-writable. Owner and creation time are host/database data, even for super; forbidden whole-record edits must fail atomically while the original id remains readable. Keep REST, mutation tool, direct runtime and manifest coverage together.
- `manifest.ui: './ui'` is assembled into a portable static mount. `pnpm plugins:ui:build` builds it into ui/dist using the actual @greenhouse/ui-tokens helper. Never embed a session credential in assets; the host supplies narrow tokens after load.
- Tests cover both generated SDK 2 and legacy transports; `tests/client-e2e/plugins.e2e.ts` covers the client surfaces. Do not change migration checksums to reset the example.
