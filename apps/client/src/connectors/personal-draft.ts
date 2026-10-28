/**
 * My own (personal, `me/<slug>`) connector form, React-free (./personal-draft.test.ts): the draft
 * the browser form edits and the body it writes. A personal connector sends nothing or my own key
 * or sign-in (`none` / `per_member`); team-only fields (shared keys, private networks, external
 * writes) are never sent, as the station refuses them (apps/api/src/connectors/manage.ts).
 */

import type { PersonalConnector } from '../api/connectors';

export const PERSONAL_SLUG_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export type PersonalAuth = 'none' | 'key' | 'oauth';

export interface PersonalDraft {
  slug: string;
  name: string;
  description: string;
  url: string;
  transport: 'streamable_http' | 'sse';
  auth: PersonalAuth;
  key_place: 'header' | 'query';
  auth_header: string;
  auth_query_param: string;
  auth_value_prefix: string;
  oauth_scope: string;
  oauth_client_id: string;
  /** Write-only: sent only when typed. */
  oauth_client_secret: string;
}

export function personalDraft(existing?: PersonalConnector): PersonalDraft {
  if (!existing)
    return {
      slug: '',
      name: '',
      description: '',
      url: '',
      transport: 'streamable_http',
      auth: 'none',
      key_place: 'header',
      auth_header: 'Authorization',
      auth_query_param: '',
      auth_value_prefix: 'Bearer ',
      oauth_scope: '',
      oauth_client_id: '',
      oauth_client_secret: '',
    };
  return {
    slug: existing.slug,
    name: existing.name,
    description: existing.description ?? '',
    url: existing.url,
    transport: existing.transport,
    auth: existing.auth_mode === 'per_member' ? (existing.auth_kind ?? 'key') : 'none',
    key_place: existing.auth_query_param ? 'query' : 'header',
    auth_header: existing.auth_header ?? 'Authorization',
    auth_query_param: existing.auth_query_param ?? '',
    auth_value_prefix: existing.auth_value_prefix ?? '',
    oauth_scope: existing.oauth_scope ?? '',
    oauth_client_id: existing.oauth_client?.source === 'manual' ? existing.oauth_client.client_id : '',
    oauth_client_secret: '',
  };
}

/** The create body; an update sends the same without `slug` (the handle is fixed). */
export function personalInput(d: PersonalDraft): Record<string, unknown> {
  const key = d.auth === 'key';
  const oauth = d.auth === 'oauth';
  return {
    slug: d.slug.trim(),
    name: d.name.trim(),
    description: d.description.trim() || null,
    url: d.url.trim(),
    transport: d.transport,
    auth_mode: d.auth === 'none' ? 'none' : 'per_member',
    auth_kind: d.auth === 'none' ? null : d.auth,
    auth_header: key && d.key_place === 'header' ? d.auth_header.trim() || null : null,
    auth_query_param: key && d.key_place === 'query' ? d.auth_query_param.trim() || null : null,
    auth_value_prefix: key ? d.auth_value_prefix || null : null,
    oauth_scope: oauth ? d.oauth_scope.trim() || null : null,
    oauth_client_id: oauth ? d.oauth_client_id.trim() || null : null,
    ...(oauth && d.oauth_client_secret ? { oauth_client_secret: d.oauth_client_secret } : {}),
  };
}

export function personalUpdate(d: PersonalDraft): Record<string, unknown> {
  const { slug: _slug, ...update } = personalInput(d);
  return update;
}

/** A name and an address, and for a new one a valid handle. */
export const personalReady = (d: PersonalDraft, existing: boolean) =>
  !!d.name.trim() && !!d.url.trim() && (existing || PERSONAL_SLUG_PATTERN.test(d.slug.trim()));

/** Saving this edit forgets my stored key or sign-in (a new address or sign-in method). */
export const dropsMyConnection = (existing: PersonalConnector, d: PersonalDraft) =>
  existing.url !== d.url.trim() || personalDraft(existing).auth !== d.auth;
