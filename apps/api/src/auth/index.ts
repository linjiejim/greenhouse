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
