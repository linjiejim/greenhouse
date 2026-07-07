/**
 * Auth module barrel export.
 */

export { hashPassword, verifyPassword } from './password.js';
export {
  createAccessToken,
  validateAccessToken,
  createRefreshToken,
  hashRefreshToken,
  verifyExternalPassword,
  isAuthEnabled,
  createInternalToken,
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL,
} from './token.js';
export type { TokenPayload, AuthUser, UserRole } from './token.js';
export { authMiddleware, getAuthUser, requireRole, requireInternal, requireSuper } from './middleware.js';
// SSO — unified identity binding + provider connectors (auth/sso/).
export {
  getSsoConnectors,
  getSsoConnector,
  signSsoState,
  verifySsoState,
  sanitizeRedirect,
  issueLoginTicket,
  redeemLoginTicket,
} from './sso/index.js';
export type { SsoConnector, SsoIdentity } from './sso/index.js';
