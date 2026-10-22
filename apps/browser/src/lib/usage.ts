/**
 * Module usage: one side-panel open counts as a `page_open` of `chat` from the
 * browser extension (the client comes from the header authFetch sets).
 * Fire-and-forget — a lost count never reaches the user.
 */

import { authFetch } from './auth';

export function reportPanelOpen(): void {
  void authFetch('/api/usage/page-open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ module: 'chat' }),
  }).catch(() => undefined);
}
