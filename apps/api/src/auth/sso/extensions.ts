/**
 * Fork extension point for private SSO connectors.
 *
 * Upstream ships EMPTY (guard test pins this). A downstream fork adds its
 * private IdP (DingTalk / corporate OIDC / …) here as a `SsoConnector`; the
 * registry splices these in after the env-driven built-ins, so the fork never
 * edits registry.ts and the file stays byte-identical to upstream.
 *
 * Fork example (in the fork's copy of this file):
 *   import { createDingtalkConnector } from './dingtalk.js';
 *   export const EXTENSION_SSO_CONNECTORS: SsoConnector[] = [
 *     createDingtalkConnector({ ... }),
 *   ];
 */

import type { SsoConnector } from './types.js';

/** Private fork connectors. Empty upstream. */
export const EXTENSION_SSO_CONNECTORS: SsoConnector[] = [];
