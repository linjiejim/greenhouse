/**
 * 团队网关 (LLM Gateway) — web API client.
 *
 * 用户自助：拉取可选模型目录、无感签发/轮换默认 key、管理网关 key。
 * 管理员：上游池 + 模型目录 + 网关 key 治理。
 *
 * 所有请求走 authFetch（自动带内部用户 Bearer token + 401 续期）。
 */

import { authFetch } from './auth';

// ─── User-facing types ───────────────────────────────────

export interface GatewayCatalogModel {
  public_id: string;
  display_name: string;
  is_default: boolean;
  is_public: boolean;
}

export interface GatewayKey {
  id: string;
  name: string;
  app_id: string;
  status: 'active' | 'disabled';
  auto: boolean;
  allowed_models: string[] | null;
  rate_limit_rpm: number;
  rate_limit_rpd: number;
  daily_token_limit: number;
  created_at: string;
  updated_at: string;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  return data;
}

/** Enabled gateway models the current user may select. */
export async function fetchGatewayCatalog(): Promise<GatewayCatalogModel[]> {
  const res = await authFetch('/api/auth/llm-keys/catalog');
  const data = await jsonOrThrow<{ models: GatewayCatalogModel[] }>(res);
  return data.models ?? [];
}

/** Seamless provision — get-or-rotate the user's default gateway key (returns raw once). */
export async function provisionGatewayKey(): Promise<{ key: GatewayKey; api_key: string }> {
  const res = await authFetch('/api/auth/llm-keys/provision', { method: 'POST' });
  return jsonOrThrow<{ key: GatewayKey; api_key: string }>(res);
}

export async function listGatewayKeys(): Promise<{ keys: GatewayKey[]; limit: number; count: number }> {
  const res = await authFetch('/api/auth/llm-keys');
  return jsonOrThrow<{ keys: GatewayKey[]; limit: number; count: number }>(res);
}

export async function createGatewayKey(input: {
  name?: string;
  allowed_models?: string[];
}): Promise<{ key: GatewayKey; api_key: string }> {
  const res = await authFetch('/api/auth/llm-keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return jsonOrThrow<{ key: GatewayKey; api_key: string }>(res);
}

export async function deleteGatewayKey(id: string): Promise<void> {
  const res = await authFetch(`/api/auth/llm-keys/${id}`, { method: 'DELETE' });
  await jsonOrThrow(res);
}

// ─── Admin types ─────────────────────────────────────────

export type GatewayUpstreamKind = 'openai' | 'anthropic' | 'deepseek' | 'openai-compatible';

export interface GatewayUpstream {
  id: string;
  name: string;
  provider_kind: GatewayUpstreamKind;
  base_url: string;
  has_key: boolean;
  enabled: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface GatewayModel {
  id: string;
  public_id: string;
  display_name: string;
  upstream_id: string;
  upstream_model: string;
  enabled: boolean;
  is_default: boolean;
  is_public: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface AdminGatewayKey extends GatewayKey {
  user_id: string | null;
  today_tokens: number;
}

// ─── Admin: upstreams ────────────────────────────────────

export async function adminListUpstreams(): Promise<GatewayUpstream[]> {
  const res = await authFetch('/api/admin/llm-gateway/upstreams');
  return (await jsonOrThrow<{ upstreams: GatewayUpstream[] }>(res)).upstreams ?? [];
}

export async function adminCreateUpstream(input: {
  name: string;
  provider_kind: GatewayUpstreamKind;
  base_url: string;
  api_key: string;
  enabled?: boolean;
}): Promise<GatewayUpstream> {
  const res = await authFetch('/api/admin/llm-gateway/upstreams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await jsonOrThrow<{ upstream: GatewayUpstream }>(res)).upstream;
}

export async function adminUpdateUpstream(
  id: string,
  patch: Partial<{
    name: string;
    provider_kind: GatewayUpstreamKind;
    base_url: string;
    api_key: string;
    enabled: boolean;
  }>,
): Promise<void> {
  const res = await authFetch(`/api/admin/llm-gateway/upstreams/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  await jsonOrThrow(res);
}

export async function adminDeleteUpstream(id: string): Promise<void> {
  const res = await authFetch(`/api/admin/llm-gateway/upstreams/${id}`, { method: 'DELETE' });
  await jsonOrThrow(res);
}

// ─── Admin: models ───────────────────────────────────────

export async function adminListModels(): Promise<GatewayModel[]> {
  const res = await authFetch('/api/admin/llm-gateway/models');
  return (await jsonOrThrow<{ models: GatewayModel[] }>(res)).models ?? [];
}

export async function adminCreateModel(input: {
  public_id: string;
  display_name: string;
  upstream_id: string;
  upstream_model: string;
  enabled?: boolean;
  is_default?: boolean;
  is_public?: boolean;
  sort_order?: number;
}): Promise<GatewayModel> {
  const res = await authFetch('/api/admin/llm-gateway/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await jsonOrThrow<{ model: GatewayModel }>(res)).model;
}

export async function adminUpdateModel(
  id: string,
  patch: Partial<Omit<GatewayModel, 'id' | 'public_id' | 'created_at' | 'updated_at'>>,
): Promise<void> {
  const res = await authFetch(`/api/admin/llm-gateway/models/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  await jsonOrThrow(res);
}

export async function adminDeleteModel(id: string): Promise<void> {
  const res = await authFetch(`/api/admin/llm-gateway/models/${id}`, { method: 'DELETE' });
  await jsonOrThrow(res);
}

// ─── Admin: relay keys ───────────────────────────────────

export async function adminListGatewayKeys(): Promise<AdminGatewayKey[]> {
  const res = await authFetch('/api/admin/llm-gateway/keys');
  return (await jsonOrThrow<{ keys: AdminGatewayKey[] }>(res)).keys ?? [];
}

export async function adminUpdateGatewayKey(
  id: string,
  patch: Partial<{
    status: 'active' | 'disabled';
    daily_token_limit: number;
    rate_limit_rpm: number;
    rate_limit_rpd: number;
    allowed_models: string[] | null;
  }>,
): Promise<void> {
  const res = await authFetch(`/api/admin/llm-gateway/keys/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  await jsonOrThrow(res);
}

export async function adminDeleteGatewayKey(id: string): Promise<void> {
  const res = await authFetch(`/api/admin/llm-gateway/keys/${id}`, { method: 'DELETE' });
  await jsonOrThrow(res);
}
