/**
 * Identity providers (Feishu, WeCom, …) as client glue. Each official plugin that brings one
 * describes it under src/plugins/<id>/ and ./identity-registry.ts only lists them; the sign-in
 * page and Me → Connections read the list, never a provider by name. React-free (./identity.test.ts).
 *
 * The station decides what is on: a provider shows only when its plugin is enabled and configured
 * (`/api/auth/providers` before sign-in, the station manifest's `identityProviders` after it).
 */

import type { TranslationKey } from '../lib/i18n';
import type { PublicProvider } from '../login/availability';

/** What a return to the sign-in page says, read from its fragment parameters. */
export type ProviderReturn = { kind: 'code'; code: string } | { kind: 'error'; reason: string } | null;

export interface IdentityGlue {
  /** The provider id the station uses (`/api/auth/providers`, the manifest). */
  id: string;
  /** Its name for people. */
  title: TranslationKey;
  /** The provider's API prefix (the server's `IdentityProvider.path`): `/oauth/start`, `/binding`. */
  path: string;
  /** Browser sign-in, when the provider offers it. */
  login?: {
    /** Answers `{ authorize_url }` for a sign-in that returns to the client's `/login`; mints a state, so only on a click. */
    startPath: string;
    /** Turns the one-shot code into a session (`{ accessToken, refreshToken }`). */
    exchangePath: string;
    read: (params: URLSearchParams) => ProviderReturn;
    errorKey: (reason: string) => TranslationKey;
    /** Start without a click (inside the provider's own app); the glue allows it once per tab. */
    autoStart?: () => boolean;
  };
}

/** The providers to offer on the sign-in page: configured on the station, signing in, known here. */
export function signInProviders(glue: readonly IdentityGlue[], discovered: readonly PublicProvider[]): IdentityGlue[] {
  return glue.filter((item) => item.login && discovered.some((provider) => provider.id === item.id && provider.login));
}

/** The providers a member can bind an account of: the manifest's binding providers known here. */
export function bindingProviders(
  glue: readonly IdentityGlue[],
  manifest: readonly { id: string; bind?: boolean }[] | undefined,
): IdentityGlue[] {
  return glue.filter((item) => manifest?.some((provider) => provider.id === item.id && provider.bind === true));
}

/** A binding return (`/bindings?<provider>=ok|error&reason=`) for a provider known here, or null. */
export function bindingReturn(
  glue: readonly IdentityGlue[],
  params: URLSearchParams,
): { provider: IdentityGlue; ok: boolean; reason: string } | null {
  for (const provider of glue) {
    const outcome = params.get(provider.id);
    if (outcome === 'ok') return { provider, ok: true, reason: '' };
    if (outcome === 'error') return { provider, ok: false, reason: (params.get('reason') ?? 'unknown').slice(0, 64) };
  }
  return null;
}
