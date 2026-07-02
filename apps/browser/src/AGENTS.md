# apps/browser — Chrome extension (MV3)

Thin client of a **self-hosted Greenhouse instance**: the user supplies a base
URL + email/password in the options page; the agent brain, tools and knowledge
stay server-side. The extension only captures context, calls the API and
renders.

## Layout

```
public/manifest.json   # static MV3 manifest, copied verbatim into dist/
sidepanel.html         # side panel entry (React)
options.html           # options page entry (React)
src/
├── background/        # service worker — owns refresh-token rotation (single-flight)
├── lib/               # storage (chrome.storage.local slot), auth client, hooks
├── i18n/              # en/zh catalogs, registered into @greenhouse/ui's i18n mechanism
├── options/           # connect + sign-in + preferences UI
├── sidepanel/         # main panel UI
└── styles.css         # tailwind v4 + @greenhouse/ui tokens.css
```

## Rules

- **Build**: `pnpm -F @greenhouse/browser build` → `dist/`, then Chrome →
  Extensions → Load unpacked → `apps/browser/dist`. `pnpm dev` = watch build +
  manual extension reload (no HMR).
- **UI comes from `@greenhouse/ui`** (atoms, markdown, tool-call cards, tokens,
  i18n mechanism). Same discipline as the package itself: no zustand, no
  router. Extension-local state lives in `chrome.storage` + React state.
- **Auth**: never store the password — only the `/api/auth/login` token pair in
  `chrome.storage.local` (`src/lib/storage.ts`, single `auth` slot). All token
  refreshes go through the background worker (`auth:refresh` runtime message)
  so rotation can't race between contexts. `authFetch()` retries once after a
  401-triggered refresh; on a dead refresh token the background clears the slot
  and every page falls back to the login flow via `storage.onChanged`.
- **Permissions**: keep the static permission set minimal (`storage`,
  `sidePanel`, `scripting`, `activeTab`). Host access to the instance is
  requested at connect time via `optional_host_permissions` — never add
  `<all_urls>` to `host_permissions`.
- **No resident content scripts.** Page context (M2+) is read on demand with
  `chrome.scripting.executeScript` under `activeTab`.
- **i18n**: extension keys live in `src/i18n/{en,zh}.ts` (keep both in sync);
  they register through `registerCoreLocaleMessages` — same fallback chain as
  the web app.
