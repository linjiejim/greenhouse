import type { Tone } from '@greenhouse/ui/kit';
import type { Skill } from '@greenhouse/contract';
import type { MessageKey } from '../../i18n/zh';

/** The scan's word: only a skill held for review or blocked says anything. */
export const SCAN: Record<Skill['scan_status'], { word: MessageKey; tone: Tone } | null> = {
  pending: { word: 'skills.scanPending', tone: 'info' },
  clean: null,
  suspicious: { word: 'skills.scanSuspicious', tone: 'warning' },
  blocked: { word: 'skills.scanBlocked', tone: 'danger' },
};

export const KIND: Record<Skill['kind'], MessageKey> = {
  package: 'skills.kindPackage',
  template: 'skills.kindTemplate',
};
