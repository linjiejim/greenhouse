/**
 * The deployment switch for mobile push (docs/specs/20261010-mobile-push.md §3.4, D8).
 *
 * `MOBILE_PUSH_ENABLED` defaults on: a member's phone only gets pushes after the
 * member allowed them on it. Off (or any unrecognised value — fail closed, like
 * the trusted-execution switches) means not one request leaves for `exp.host`:
 * no device is stored, no delivery row is written, the worker claims none, and
 * the app hides its push settings. `/health` reports the state.
 */

import { defaultOnSwitch } from '../../trusted-execution/kill-switches.js';

export const MOBILE_PUSH_ENV = 'MOBILE_PUSH_ENABLED';

/** Expo Push Service (one POST per ≤100 messages of one project). */
export const EXPO_PUSH_SEND_URL = 'https://exp.host/--/api/v2/push/send';

type Environment = Record<string, string | undefined>;

export function resolveMobilePush(env: Environment = process.env): { enabled: boolean; invalid: boolean } {
  const invalid: string[] = [];
  const enabled = defaultOnSwitch(env, MOBILE_PUSH_ENV, invalid);
  return { enabled, invalid: invalid.length > 0 };
}

export function mobilePushEnabled(env: Environment = process.env): boolean {
  return resolveMobilePush(env).enabled;
}

/** Public health posture: on/off, and whether the value was unrecognised (then it is off). */
export function mobilePushHealthView(env: Environment = process.env): { enabled: boolean; invalid_env?: string } {
  const { enabled, invalid } = resolveMobilePush(env);
  return invalid ? { enabled, invalid_env: MOBILE_PUSH_ENV } : { enabled };
}
