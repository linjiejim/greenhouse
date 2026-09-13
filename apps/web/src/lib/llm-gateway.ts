/**
 * 团队网关 (LLM Gateway) — web API client.
 *
 * 管理员用于管理上游池、模型目录与网关 key。
 *
 * 所有请求走 authFetch（自动带内部用户 Bearer token + 401 续期）。
 */

import { authFetch } from './auth';

// ─── User-facing types ───────────────────────────────────

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

// ─── Admin types ─────────────────────────────────────────

/** One provider in a catalog model's fallback chain. */
export interface CatalogProvider {
  provider: string;
  model: string;
  base_url: string | null;
  api_key_env: string;
  /** Presence only — the key value never leaves the server. */
  api_key_configured: boolean;
  relay_capable: boolean;
}

export interface CatalogModel {
  id: string;
  name: string;
  is_default: boolean;
  is_public: boolean;
  /** At least one provider in the chain is usable right now. */
  ready: boolean;
  providers: CatalogProvider[];
}

export interface AdminGatewayKey extends GatewayKey {
  user_id: string;
  today_tokens: number;
}

// ─── Admin: model catalog (read-only) ────────────────────

/**
 * The catalog is declared in `apps/api/config/models.yaml` with secrets in env,
 * so there is nothing to write here — only to inspect.
 */
export async function adminGetCatalog(): Promise<{ models: CatalogModel[]; source: string }> {
  const res = await authFetch('/api/admin/llm-gateway/catalog');
  const data = await jsonOrThrow<{ models: CatalogModel[]; source: string }>(res);
  return { models: data.models ?? [], source: data.source ?? '' };
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
