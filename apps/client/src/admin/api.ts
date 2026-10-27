/**
 * Administration calls (super only on the station; every answer is an ApiResult). Paths and
 * bodies follow the classic pages they replace (apps/api/src/routes/admin*.ts).
 */
import { del, get, patch, post, put, seg } from '../api/client';
import type {
  GatewayAdminKeys,
  LinkDelivery,
  ManagedUsers,
  MeteringOverview,
  PriceInput,
  BudgetScope,
  UserAccessView,
  WorkspaceSettingView,
} from './types';

// ─── Users ───────────────────────────────────────────────
export const listUsers = () => get<ManagedUsers>('/api/admin/users');
export const createUser = (input: {
  email: string;
  nickname: string;
  credential_mode: 'email_link' | 'direct_password';
  password?: string;
}) => post<LinkDelivery>('/api/admin/users', { ...input, role: 'team' });
export const updateUser = (id: string, body: { nickname?: string; role?: 'team'; status?: 'active' | 'disabled' }) =>
  patch<unknown>(`/api/admin/users/${seg(id)}`, body);
export const deleteUser = (id: string) => del<unknown>(`/api/admin/users/${seg(id)}`);
export const resetPassword = (
  id: string,
  body: { mode: 'email_link' } | { mode: 'direct_password'; password: string },
) => post<LinkDelivery>(`/api/admin/users/${seg(id)}/reset-password`, body);
export const resendPasswordLink = (id: string) =>
  post<LinkDelivery>(`/api/admin/users/${seg(id)}/password-link/resend`);
export const revokePasswordLink = (id: string) => post<unknown>(`/api/admin/users/${seg(id)}/password-link/revoke`);
export const userAccess = (id: string) => get<UserAccessView>(`/api/admin/users/${seg(id)}/access`);
export const setUserFeature = (id: string, feature: string, enabled: boolean) =>
  put<unknown>(`/api/admin/users/${seg(id)}/features`, { feature, enabled });
export const setUserTools = (id: string, tools: string[]) =>
  put<unknown>(`/api/admin/users/${seg(id)}/tools`, { tools });

// ─── Workspace settings ──────────────────────────────────
export const listSettings = () => get<{ settings: WorkspaceSettingView[] }>('/api/admin/settings');
export const saveSettings = (values: Record<string, unknown>) =>
  put<{ settings: WorkspaceSettingView[] }>('/api/admin/settings', { values });

// ─── Services & pricing ──────────────────────────────────
export const meteringOverview = (month?: string) =>
  get<MeteringOverview>('/api/admin/metering/overview', month ? { month } : undefined);
export const savePrice = (input: PriceInput) => put<unknown>('/api/admin/metering/prices', input);
export const resetPrice = (kind: PriceInput['kind'], target: string, provider?: string) =>
  del('/api/admin/metering/prices', { kind, target, provider });
export const saveBudget = (scope: BudgetScope, limit_usd_micros: number, scope_id?: string) =>
  put<unknown>('/api/admin/metering/budgets', { scope, ...(scope_id ? { scope_id } : {}), limit_usd_micros });
export const resetBudget = (scope: BudgetScope, scope_id?: string) =>
  del('/api/admin/metering/budgets', { scope, scope_id });
export const gatewayKeys = () => get<GatewayAdminKeys>('/api/admin/metering/gateway-keys');
export const revokeGatewayKey = (id: string) => del(`/api/admin/metering/gateway-keys/${seg(id)}`);
