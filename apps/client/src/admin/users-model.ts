/** Users section rules (React-free, tested): the list's search/filters/sort and a member's link state. */
import { parseMs } from '../data/time';
import type { LinkDelivery, ManagedUser, PasswordLinkCapability } from './types';

export type UserSort = 'default' | 'month_tokens' | 'total_calls' | 'last_login';
export interface UserQuery {
  search: string;
  role: '' | 'super' | 'team';
  status: '' | 'active' | 'invited' | 'reset_required' | 'disabled';
  sort: UserSort;
}
export const EMPTY_QUERY: UserQuery = { search: '', role: '', status: '', sort: 'default' };

export function visibleUsers(users: readonly ManagedUser[], q: UserQuery): ManagedUser[] {
  const needle = q.search.trim().toLowerCase();
  const rows = users.filter(
    (u) =>
      (!needle || u.nickname.toLowerCase().includes(needle) || u.email.toLowerCase().includes(needle)) &&
      (!q.role || u.role === q.role) &&
      (!q.status || u.status === q.status),
  );
  if (q.sort === 'default') return rows;
  const key = (u: ManagedUser) =>
    q.sort === 'month_tokens'
      ? (u.usage_summary?.month_tokens ?? 0)
      : q.sort === 'total_calls'
        ? (u.usage_summary?.total_calls ?? 0)
        : parseMs(u.last_login_at) || 0;
  return [...rows].sort((a, b) => key(b) - key(a));
}

/** Supers are not edited, reset or deleted through the API (the station refuses with 403). */
export const editable = (u: ManagedUser) => u.role !== 'super';

/** The mailed link's state under a member's status: failed, expired, or pending until a date. */
export function linkState(
  u: ManagedUser,
  now = Date.now(),
): { kind: 'failed' | 'expired' | 'pending'; at: string } | null {
  const link = u.password_link;
  if (!link) return null;
  if (link.delivery_status === 'failed') return { kind: 'failed', at: link.expires_at };
  return { kind: parseMs(link.expires_at) <= now ? 'expired' : 'pending', at: link.expires_at };
}

/** Why mailed links are off on this deployment, as an `admin.users.linkOff.*` key; null when they work. */
export function linkUnavailable(
  capability: PasswordLinkCapability | null | undefined,
): 'mailbox' | 'baseUrl' | 'insecure' | 'invalid' | null {
  if (!capability || capability.available) return null;
  const reason = capability.reason;
  return reason === 'shared_mailbox_unconfigured'
    ? 'mailbox'
    : reason === 'missing_public_base_url'
      ? 'baseUrl'
      : reason === 'insecure_public_base_url'
        ? 'insecure'
        : 'invalid';
}

export const deliveryFailed = (answer: LinkDelivery | null | undefined) => answer?.delivery?.status === 'failed';

/** The create form's problem, as an `admin.users.*` key, or null when it can be sent. */
export function createProblem(form: {
  email: string;
  nickname: string;
  mode: 'email_link' | 'direct_password';
  password: string;
}): 'required' | 'passwordShort' | null {
  if (!form.email.trim() || !form.nickname.trim()) return 'required';
  if (form.mode === 'direct_password' && form.password.length < 8) return 'passwordShort';
  return null;
}

/** The PATCH body for a status toggle: activating a historical external account converts it to team. */
export function statusPatch(u: ManagedUser): { status: 'active' | 'disabled'; role?: 'team' } {
  const status = u.status === 'disabled' ? 'active' : 'disabled';
  return status === 'active' && u.role === 'external' ? { status, role: 'team' } : { status };
}
