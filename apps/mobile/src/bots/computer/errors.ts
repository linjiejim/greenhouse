/**
 * The sentence for a computer route's refusal code (web: computer-pane.tsx
 * `ERROR_KEYS`), or null — the caller then says its own "couldn't …".
 */

import type { TranslationKey } from '../../lib/i18n';

const ERROR_KEYS: Record<string, TranslationKey> = {
  disabled: 'bots.computer.errUnavailable',
  unavailable: 'bots.computer.errUnavailable',
  start_failed: 'bots.computer.reasonStartFailed',
  stopped: 'bots.computer.errNotRunning',
  over_quota: 'bots.computer.errOverQuota',
  user_in_control: 'bots.computer.errUserInControl',
  lease_required: 'bots.computer.errNotInControl',
  not_found: 'bots.computer.errNotFound',
  too_large: 'bots.computer.errTooLarge',
};

export function computerErrorKey(code: string | null | undefined): TranslationKey | null {
  return code ? (ERROR_KEYS[code] ?? null) : null;
}
