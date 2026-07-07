/**
 * SSO connector contract — the standard identity-binding interface.
 *
 * A connector adapts one external identity provider (WeCom / Feishu / a fork's
 * private IdP) to two operations: build the authorize URL the browser is sent
 * to, and exchange the callback `code` for a verified identity. Everything
 * else (state signing, ticket exchange, binding, JIT provisioning, routes) is
 * shared and provider-agnostic. See docs/specs/20260708-sso-identity-connectors.md.
 */

/** Verified identity returned by a connector after code exchange. */
export interface SsoIdentity {
  /** Stable per-provider user identifier (WeCom userid / Feishu union_id). */
  subject: string;
  /** Human-readable name from the IdP, when available. */
  displayName?: string;
  /** Email from the IdP. NOT trusted for account matching — display/JIT only. */
  email?: string;
  avatarUrl?: string;
  /** Raw provider profile, persisted to user_identities.raw_profile for diagnostics. */
  raw?: unknown;
}

export interface SsoConnector {
  /** URL-safe id, used in routes (/api/auth/sso/:id/...) and user_identities.provider. */
  id: string;
  /** Login-button label, e.g. "企业微信" / "飞书". */
  label: string;
  /**
   * Build the IdP authorize URL for a top-level browser redirect.
   * `userAgent` lets a connector pick an in-app flow (e.g. WeCom built-in
   * browser) over the generic QR/web flow.
   */
  buildAuthorizeUrl(params: { redirectUri: string; state: string; userAgent?: string }): string;
  /** Exchange the callback code for a verified identity. Throws on provider errors. */
  exchangeCode(params: { code: string; redirectUri: string }): Promise<SsoIdentity>;
}
