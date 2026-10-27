# @greenhouse/ui-tokens

Standalone theme values and the bridge for trusted Greenhouse plugin frontends.
`themeTokens.light/dark` and `tokenNames` come from `packages/ui/src/tokens`;
regenerate with `pnpm tokens:build`. `resolveThemeTokens()` fills both token naming
sets (the CSS names and the client aliases) from whichever one the host sends.

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
See plugins/example/ui and scripts/build-plugin-ui.mjs for a dependency-free
ES module build using this package.
