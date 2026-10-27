# WeCom plugin

- Default off; enablement plus restart is required independently of credentials.
- WeCom is binding-only and must not advertise sign-in; discovery/UI appears only when all required corporate credentials exist.
- Production imports use host kits/shared contracts/declared dependencies; preserve env names, routes and preference keys.
- This plugin owns no tables; provider_connections and login_states remain core and persist across disablement.
- Group webhooks send to a room; corporate-app messages target a bound member; keep these paths distinct.
- The stateful corporate token client lives here with caching, early refresh and one forced retry for expired tokens.
- OAuth start requires Bearer and returns authorize_url for the browser; callback authenticates ten-minute single-use hashed state without getAuthUser.
- The callback returns to the universal client's `/bindings?wecom=` (@greenhouse/types/client-routes); the client glue is apps/client/src/plugins/wecom.
- Recheck active internal identity before binding and reject an external identity already bound to another account.
- Personal recipients derive only from bindings; notify.wecom is a boolean, never an arbitrary target address.
- Store binding provider=wecom with null per-user access_token_enc; the corporate token is not a per-user credential.
- Application markdown is visible in WeCom; token caches are process-local and require a shared design before replica claims.
- Keep copy under ext.wecom.*; browser specs import only @playwright/test.
