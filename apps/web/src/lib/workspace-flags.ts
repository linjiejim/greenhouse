/**
 * Boolean workspace switches (`type: 'boolean'` settings such as
 * `gateway.enabled`) as an admin should see them: the value in effect, which
 * may come from the environment or the built-in default rather than a stored
 * override — never just "is there a row saying true".
 */

import type { WorkspaceFlagState, WorkspaceSettingView } from '@greenhouse/types';
import type { TranslationKey } from './i18n';

/**
 * What a switch shows in Runtime Config: a staged true/false wins; a staged
 * clear (`null`) shows what the switch falls back to without the override;
 * otherwise the value in effect.
 */
export function flagChecked(view: Pick<WorkspaceSettingView, 'flag' | 'value'>, staged: unknown): boolean {
  if (typeof staged === 'boolean') return staged;
  if (staged === null) return view.flag?.fallback ?? false;
  return view.flag?.effective ?? view.value === true;
}

/** Where a switch's effective value comes from, for a one-line note under it. */
export function flagSourceKey(source: WorkspaceFlagState['source']): TranslationKey {
  return `runtimeConfig.flagSource_${source}` as TranslationKey;
}
