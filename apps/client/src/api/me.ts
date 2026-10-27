/** The signed-in member as `/api/auth/me` answers it. React-free (./me.test.ts). */

import type { Me } from '../shared/greenhouse-types';

/** A `/api/auth/me` body's member, or null when it is not one this app can use. */
export function parseMe(body: unknown): Me | null {
  const user = (body as { user?: Partial<Me> } | null)?.user;
  if (!user || typeof user.id !== 'string' || typeof user.email !== 'string') return null;
  if (user.role !== 'super' && user.role !== 'team') return null;
  return {
    id: user.id,
    email: user.email,
    nickname: typeof user.nickname === 'string' && user.nickname.trim() ? user.nickname : user.email,
    role: user.role,
    monthly_token_limit: typeof user.monthly_token_limit === 'number' ? user.monthly_token_limit : 0,
    locale: typeof user.locale === 'string' ? user.locale : 'en',
    notes: typeof user.notes === 'string' ? user.notes : null,
    features: user.features && typeof user.features === 'object' && !Array.isArray(user.features) ? user.features : {},
  };
}

/** The app language an account locale asks for. */
export function langOf(locale: string | null | undefined): 'zh' | 'en' {
  return locale?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}
