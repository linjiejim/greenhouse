import type { TranslationKey } from '../lib/i18n';
import type { IconName } from '../ui/core';
export interface NativeScreenEntry {
  screen: string;
  route?: string;
  icon: IconName;
  endpoint?: string;
  collection?: string;
  /** What the phone's read-only list leaves to a wider window (the browser has a screen for it). */
  wideNote?: TranslationKey;
}
