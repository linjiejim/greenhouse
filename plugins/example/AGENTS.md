# Example SDK 2 data plugin

- Preserve `ext_example_notes`, applied migration bytes, legacy notes tools/routes and
  `#/example/notes/:id`. Compatibility adapters share the generated application's
  action guards/audit; their wire response stays unchanged.
- The data declaration owns read/create/update/delete/export, own/userId scope,
  column mapping, field classification, views, peek, and custom search. Do not
  hand-register duplicate generated tools/routes/search/export entries.
- Exercise stable agent context, resource and prompt, user.created observation,
  durable welcome notification and onInstall. Hooks are idempotent and metadata-only.
- `manifest.ts` is pure station metadata. Settings are administration-only; ui/ is
  a tiny public static frontend with no bundled credentials or private data.
- Tests cover both generated SDK 2 and legacy transports. Browser specs import only
  @playwright/test; do not change migration checksums to reset the example.

- `manifest.ui: './ui'` is assembled into a portable static mount. `pnpm plugins:ui:build` builds the example into ui/dist using the actual @greenhouse/ui-tokens helper. Never embed a session credential in assets; the host supplies narrow tokens after load. Browser specs cover entity detail/edit, scoped settings, theme/refresh/navigation/drafts and token escapes.
