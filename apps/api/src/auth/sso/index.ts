/**
 * SSO module barrel — unified identity binding + provider connectors.
 * See docs/specs/20260708-sso-identity-connectors.md.
 */

export type { SsoConnector, SsoIdentity } from './types.js';
export { signSsoState, verifySsoState, sanitizeRedirect, type SsoStatePayload } from './state.js';
export { issueLoginTicket, redeemLoginTicket, sweepExpiredTickets } from './tickets.js';
export {
  getSsoConnectors,
  getSsoConnector,
  autoProvisionEnabled,
  autoProvisionRole,
  _resetSsoConnectorsForTests,
} from './registry.js';
export { createWecomConnector, type WecomConfig } from './wecom.js';
export { createFeishuConnector, type FeishuConfig } from './feishu.js';
export { EXTENSION_SSO_CONNECTORS } from './extensions.js';
