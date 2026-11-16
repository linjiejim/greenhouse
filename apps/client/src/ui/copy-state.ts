/** What a copy button says (./use-copy): its own words, then 已复制 or 复制失败 for 1.5 s on the web. */
import type { TFunction } from '../lib/i18n';

export type CopyState = 'idle' | 'copied' | 'failed';

export function copyLabel(state: CopyState, idle: string, t: TFunction): string {
  return state === 'copied' ? t('common.copied') : state === 'failed' ? t('common.copyFailed') : idle;
}
