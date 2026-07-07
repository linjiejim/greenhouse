/**
 * SSO routes — /api/auth/sso (unified identity binding + provider login)
 *
 * GET    /api/auth/sso/providers            — enabled providers (public; login buttons)
 * GET    /api/auth/sso/:provider/authorize  — redirect to the IdP (public; login flow)
 * GET    /api/auth/sso/:provider/callback   — IdP redirect target (public; state-verified)
 * POST   /api/auth/sso/exchange             — one-time ticket → token pair (public)
 * POST   /api/auth/sso/:provider/bind-url   — authorize URL for binding (internal users)
 * GET    /api/auth/sso/identities           — current user's bound identities (internal)
 * DELETE /api/auth/sso/identities/:provider — unbind (internal)
 *
 * Flows, error codes, and security decisions:
 * docs/specs/20260708-sso-identity-connectors.md
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { getDb } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { getAuthUser } from '../auth/middleware.js';
import { createAccessToken, createRefreshToken } from '../auth/token.js';
import {
  getSsoConnector,
  getSsoConnectors,
  signSsoState,
  verifySsoState,
  sanitizeRedirect,
  issueLoginTicket,
  redeemLoginTicket,
  autoProvisionEnabled,
  autoProvisionRole,
  type SsoIdentity,
} from '../auth/sso/index.js';
import type { AppEnv } from '../app-env.js';

/**
 * password_hash sentinel for JIT-provisioned accounts that never set a
 * password. Not a valid scrypt "salt:key" pair, so verifyPassword() can never
 * match it (same trick as the external system user's 'NOLOGIN').
 */
export const SSO_PASSWORD_SENTINEL = 'SSO_ONLY';

// ─── URL helpers ─────────────────────────────────────────

/** External base URL for IdP callbacks: SSO_PUBLIC_BASE_URL, else the request origin. */
function publicBaseUrl(c: Context): string {
  const env = process.env.SSO_PUBLIC_BASE_URL;
  if (env) return env.replace(/\/+$/, '');
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host')?.split(',')[0]?.trim() || c.req.header('host') || url.host;
  return `${proto}://${host}`;
}

function callbackUri(c: Context, providerId: string): string {
  return `${publicBaseUrl(c)}/api/auth/sso/${providerId}/callback`;
}

/** Append query params to a relative target that may carry its own query/hash. */
export function appendQuery(target: string, params: Record<string, string>): string {
  const [pathAndQuery, ...hashParts] = target.split('#');
  const hash = hashParts.length > 0 ? `#${hashParts.join('#')}` : '';
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  return `${pathAndQuery}${sep}${new URLSearchParams(params).toString()}${hash}`;
}

// ─── JIT provisioning helpers ────────────────────────────

const EMAILISH = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Deterministic placeholder email when the IdP exposes none (users.email is NOT NULL UNIQUE). */
export function synthesizeEmail(providerId: string, subject: string): string {
  const slug =
    subject
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'user';
  return `${providerId}-${slug}@sso.local`;
}

function identityDisplayFields(identity: SsoIdentity) {
  let raw: string | null;
  try {
    raw = identity.raw === undefined ? null : (JSON.stringify(identity.raw) ?? null);
  } catch {
    raw = null;
  }
  return {
    display_name: identity.displayName ?? null,
    avatar_url: identity.avatarUrl ?? null,
    raw_profile: raw,
  };
}

// ─── Routes ──────────────────────────────────────────────

const sso = new Hono<AppEnv>()
  // ─── Enabled providers (login page buttons) ─────────────

  /** GET /api/auth/sso/providers — public list of enabled providers */
  .get('/providers', (c) => {
    const providers = getSsoConnectors().map(({ id, label }) => ({ id, label }));
    return c.json({ providers });
  })
  // ─── Login flow entry ───────────────────────────────────

  /** GET /api/auth/sso/:provider/authorize — redirect the browser to the IdP */
  .get('/:provider/authorize', (c) => {
    const providerId = c.req.param('provider');
    const connector = getSsoConnector(providerId);
    if (!connector) return c.json({ error: 'Unknown SSO provider' }, 404);

    const redirect = sanitizeRedirect(c.req.query('redirect'));
    const state = signSsoState({ provider: providerId, purpose: 'login', redirect });
    const url = connector.buildAuthorizeUrl({
      redirectUri: callbackUri(c, providerId),
      state,
      userAgent: c.req.header('user-agent'),
    });
    return c.redirect(url, 302);
  })
  // ─── IdP callback (login + bind) ────────────────────────

  /** GET /api/auth/sso/:provider/callback — verify state, exchange code, land back in the SPA */
  .get('/:provider/callback', async (c) => {
    const providerId = c.req.param('provider');
    const connector = getSsoConnector(providerId);
    if (!connector) return c.json({ error: 'Unknown SSO provider' }, 404);

    const rawState = c.req.query('state');
    const state = rawState ? verifySsoState(rawState) : null;
    if (!state || state.provider !== providerId) {
      return c.redirect(appendQuery('/', { sso_error: 'invalid_state' }), 302);
    }
    const redirect = sanitizeRedirect(state.redirect);
    const failKey = state.purpose === 'bind' ? 'sso_bind' : 'sso_error';
    const fail = (code: string) => c.redirect(appendQuery(redirect, { [failKey]: code }), 302);

    const code = c.req.query('code');
    if (!code) return fail('provider_error'); // user cancelled at the IdP, or IdP error

    let identity: SsoIdentity;
    try {
      identity = await connector.exchangeCode({ code, redirectUri: callbackUri(c, providerId) });
    } catch (err) {
      logger.warn('[sso] code exchange failed', { provider: providerId, error: toErrorMessage(err) });
      return fail('provider_error');
    }

    const db = getDb();
    const existing = await db.userIdentities.getByProviderSubject(providerId, identity.subject);

    // ── Bind: attach this identity to the user embedded in the signed state ──
    if (state.purpose === 'bind') {
      const uid = state.uid;
      if (!uid) return fail('invalid_state');
      if (existing) {
        if (existing.user_id !== uid) return fail('already_bound'); // taken by another account
        await db.userIdentities.touchLogin(existing.id, identityDisplayFields(identity)); // idempotent re-bind
        return fail('ok');
      }
      const user = await db.users.getById(uid);
      if (!user || user.status === 'disabled' || user.role === 'external') return fail('invalid_state');
      if (await db.userIdentities.getByUserAndProvider(uid, providerId)) {
        return fail('provider_already_linked'); // unbind first, then bind the new one
      }
      await db.userIdentities.create({
        user_id: uid,
        provider: providerId,
        subject: identity.subject,
        ...identityDisplayFields(identity),
      });
      logger.info('[sso] identity bound', { provider: providerId, userId: uid });
      return fail('ok');
    }

    // ── Login: resolve the bound account, or JIT-provision when enabled ──
    let userId: string;
    if (existing) {
      userId = existing.user_id;
    } else {
      if (!autoProvisionEnabled()) return fail('not_bound');
      // NO email-based auto-merge: IdP emails are not verified here, and silently
      // attaching to an existing account would be an account-takeover vector.
      const email =
        identity.email && EMAILISH.test(identity.email)
          ? identity.email
          : synthesizeEmail(providerId, identity.subject);
      if (await db.users.getByEmail(email)) return fail('email_conflict');
      const created = await db.users.create({
        email,
        password_hash: SSO_PASSWORD_SENTINEL,
        nickname: identity.displayName || identity.subject,
        role: autoProvisionRole(),
        created_by: `sso:${providerId}`,
      });
      await db.userIdentities.create({
        user_id: created.id,
        provider: providerId,
        subject: identity.subject,
        ...identityDisplayFields(identity),
      });
      logger.info('[sso] user auto-provisioned', { provider: providerId, userId: created.id });
      userId = created.id;
    }

    const user = await db.users.getById(userId);
    if (!user) return fail('not_bound');
    if (user.status === 'disabled') return fail('account_disabled');

    if (existing) await db.userIdentities.touchLogin(existing.id, identityDisplayFields(identity));
    await db.users.updateLastLogin(user.id);

    const ticket = issueLoginTicket(user.id);
    return c.redirect(appendQuery(redirect, { sso_ticket: ticket }), 302);
  })
  // ─── Ticket exchange ────────────────────────────────────

  /** POST /api/auth/sso/exchange — one-time ticket → access/refresh pair (same shape as /login) */
  .post('/exchange', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ticket?: string };
    if (!body.ticket) return c.json({ error: 'Ticket is required' }, 400);

    const redeemed = redeemLoginTicket(body.ticket);
    if (!redeemed) return c.json({ error: 'Invalid or expired ticket' }, 401);

    const user = await getDb().users.getById(redeemed.userId);
    if (!user || user.status === 'disabled') {
      return c.json({ error: 'Account not found or disabled' }, 401);
    }

    const accessToken = createAccessToken(user.id, user.role);
    const refresh = createRefreshToken();
    await getDb().refreshTokens.create(user.id, refresh.hash, refresh.expiresAt);

    const profiles = user.role !== 'external' ? [] : await getDb().userProfiles.getProfiles(user.id);

    return c.json({
      accessToken,
      refreshToken: refresh.raw,
      user: {
        id: user.id,
        email: user.email,
        nickname: user.nickname,
        role: user.role,
        profiles,
        daily_message_limit: user.daily_message_limit,
        monthly_token_limit: user.monthly_token_limit,
        locale: user.locale ?? 'en',
      },
    });
  })
  // ─── Bind flow entry (authed) ───────────────────────────

  /** POST /api/auth/sso/:provider/bind-url — authorize URL that binds to the current user */
  .post('/:provider/bind-url', async (c) => {
    const authUser = getAuthUser(c);
    if (authUser.role === 'external') {
      return c.json({ error: 'External users cannot bind identities' }, 403);
    }
    const providerId = c.req.param('provider');
    const connector = getSsoConnector(providerId);
    if (!connector) return c.json({ error: 'Unknown SSO provider' }, 404);

    const body = (await c.req.json().catch(() => ({}))) as { redirect?: string };
    const redirect = sanitizeRedirect(body.redirect);
    const state = signSsoState({ provider: providerId, purpose: 'bind', uid: authUser.id, redirect });
    const url = connector.buildAuthorizeUrl({
      redirectUri: callbackUri(c, providerId),
      state,
      userAgent: c.req.header('user-agent'),
    });
    return c.json({ url });
  })
  // ─── Self-service identity management (authed) ──────────

  /** GET /api/auth/sso/identities — current user's bound identities */
  .get('/identities', async (c) => {
    const authUser = getAuthUser(c);
    if (authUser.role === 'external') {
      return c.json({ error: 'External users have no identities' }, 403);
    }
    const rows = await getDb().userIdentities.listByUser(authUser.id);
    const identities = rows.map((r) => ({
      provider: r.provider,
      subject: r.subject,
      display_name: r.display_name,
      avatar_url: r.avatar_url,
      created_at: r.created_at,
      last_login_at: r.last_login_at,
    }));
    return c.json({ identities });
  })
  /** DELETE /api/auth/sso/identities/:provider — unbind one identity */
  .delete('/identities/:provider', async (c) => {
    const authUser = getAuthUser(c);
    if (authUser.role === 'external') {
      return c.json({ error: 'External users have no identities' }, 403);
    }
    const providerId = c.req.param('provider');
    const db = getDb();

    const user = await db.users.getById(authUser.id);
    if (!user) return c.json({ error: 'User not found' }, 404);

    const rows = await db.userIdentities.listByUser(authUser.id);
    const target = rows.find((r) => r.provider === providerId);
    if (!target) return c.json({ error: 'Identity not found' }, 404);

    // A JIT-provisioned account with no password would be locked out for good
    // after unbinding its last identity — require a password first.
    if (user.password_hash === SSO_PASSWORD_SENTINEL && rows.length === 1) {
      return c.json(
        { error: 'This account has no password. Ask an administrator to set one before unbinding the last identity.' },
        400,
      );
    }

    await db.userIdentities.deleteByUserAndProvider(authUser.id, providerId);
    logger.info('[sso] identity unbound', { provider: providerId, userId: authUser.id });
    return c.json({ deleted: true });
  });

export default sso;
