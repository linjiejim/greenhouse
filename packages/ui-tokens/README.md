# @greenhouse/ui-tokens

Standalone theme values and the bridge for trusted Greenhouse plugin frontends.
`themeTokens.light/dark` and `tokenNames` come from `packages/ui/src/tokens`;
regenerate with `pnpm tokens:build`. Every name is a `--gh-*` client palette key (or the
shared ramp, type, radius and motion variables); `resolveThemeTokens()` lays the host's
overrides over the defaults.

```ts
import { connectGreenhouse } from '@greenhouse/ui-tokens';
const host = connectGreenhouse({ onInit: ({ user }) => showMember(user) });
// After init, API requests use host.token as their bearer.
await host.refresh();
host.navigate('/p/example/example-embed'); // a client route
host.sendPrompt('Help me organize my notes'); // editable draft, never sent
// Dispose event handlers when unmounting:
host.disconnect();
```

The helper checks the exact parent window and origin, applies init/theme tokens
to document.documentElement, and exposes context/token/refresh/navigate/title/
sendPrompt. Refresh requests are deduplicated and time out after 15 seconds.
The host supplies a ten-minute plugin-scoped credential; no interactive session
credential belongs in plugin code or storage.

Native WebView injection is accepted only in a top-level native bridge; browser
frames always validate the exact parent window and origin.

The default parent origin is the page's own origin. An installed desktop plugin
must explicitly allowlist the `host_origin=tauri://localhost` hint before passing
that exact value as `hostOrigin`. Never trust arbitrary query-string origins.
Confirms and notices are drawn by the host: `host.confirm({ title, confirmLabel, tone })`
resolves the member's answer; `host.notify({ kind, text, actionLabel })` resolves `action` when
its action is pressed. `host.header(actions)` puts icon actions in the host bar, `host.route('#/…')`
keeps the page's view in the host address, and `onTimeout` fires when no init arrives in 10 s.

See plugins/example/ui and plugins/example/scripts/build-ui.mjs for a dependency-free
ES module build using this package. A bundled embed imports the preset after Tailwind
(`@import "@greenhouse/ui-tokens/tailwind.css"`: colours, type scale, radii, elevation, motion,
Nunito, a `dark:` variant on the host theme) and, with React, the kit from
`@greenhouse/ui-tokens/react` (see EXTENDING.md and plugins/assets/ui-src).
