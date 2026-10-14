/**
 * Small formatting helpers shared across screens: the time-of-day greeting and file sizes.
 * Times live in ../data/time.ts (Hermes-safe parsing, relative times).
 */

import { t } from './i18n';

/** Time-of-day greeting prefix. */
export function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return t('home.greetingDawn');
  if (h < 12) return t('home.greetingMorning');
  if (h < 14) return t('home.greetingNoon');
  if (h < 18) return t('home.greetingAfternoon');
  return t('home.greetingEvening');
}

/** File size: 512 → "512 B", 12_345 → "12.1 KB", 3_400_000 → "3.2 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
}
