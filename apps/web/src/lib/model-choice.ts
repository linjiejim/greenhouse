/**
 * Model choice helpers — profiles that declare `model_choices` let the user
 * switch the chat model (e.g. team's 快思考/慢思考). Profiles without choices
 * are pinned server-side; the picker is hidden and no override is sent.
 */

import type { Profile } from '@greenhouse/types/api';

export type ModelChoice = NonNullable<Profile['model_choices']>[number];

const STORAGE_KEY = 'greenhouse-thinking-mode';
// Legacy persisted values from the old fast/slow toggle → registry ids.
const LEGACY_VALUES: Record<string, string> = { fast: 'flash', slow: 'pro' };

export function readStoredModelChoice(): string {
  const saved = localStorage.getItem(STORAGE_KEY) || 'flash';
  return LEGACY_VALUES[saved] ?? saved;
}

export function storeModelChoice(choiceId: string): void {
  localStorage.setItem(STORAGE_KEY, choiceId);
}

export function getModelChoices(profile: Profile | undefined): ModelChoice[] {
  return profile?.model_choices ?? [];
}

/** The choice id highlighted in the picker — falls back to the first choice. */
export function effectiveModelChoice(choices: ModelChoice[], selected: string): string | undefined {
  if (choices.length === 0) return undefined;
  return choices.some((c) => c.id === selected) ? selected : choices[0].id;
}

/**
 * The model_override to send for the current profile, or undefined when the
 * profile pins its model. Sending the first (default) choice explicitly is
 * fine — the server validates against the profile's declared choices anyway.
 */
export function modelOverrideFor(choices: ModelChoice[], selected: string): string | undefined {
  return effectiveModelChoice(choices, selected);
}

/**
 * Localized tooltip for a choice. Known registry ids map to i18n keys
 * (value→key pattern, see web-i18n conventions); others fall back to the
 * server-provided label.
 */
export function modelChoiceTitle(
  choice: ModelChoice,
  t: (key: 'chat.fastThinking' | 'chat.deepThinking') => string,
): string {
  if (choice.id === 'flash') return t('chat.fastThinking');
  if (choice.id === 'pro') return t('chat.deepThinking');
  return choice.label;
}
