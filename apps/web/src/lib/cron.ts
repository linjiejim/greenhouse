/**
 * Friendly schedules ↔ standard 5-field cron, for every schedule editor (the
 * scheduled-task form and Tables automations share `components/schedule-builder.tsx`).
 *
 * People pick a frequency + time (+ weekdays / day of month); the cron string is
 * what is stored. Expressions that don't fit these shapes stay editable as raw
 * cron — the escape hatch, never the default.
 */

import type { TranslationKey } from './i18n';

export type ScheduleFrequency = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'cron';

export interface ScheduleState {
  freq: ScheduleFrequency;
  /** `HH:MM` */
  time: string;
  /** 0 (Sun) – 6 (Sat), for `weekly`. */
  weekdays: number[];
  /** 1–31, for `monthly`. */
  monthDay: number;
  /** The expression, for `cron`. */
  raw: string;
}

export const SCHEDULE_FREQUENCIES: ReadonlyArray<{ value: ScheduleFrequency; labelKey: TranslationKey }> = [
  { value: 'daily', labelKey: 'automations.freqDaily' },
  { value: 'weekdays', labelKey: 'automations.freqWeekdays' },
  { value: 'weekly', labelKey: 'automations.freqWeekly' },
  { value: 'monthly', labelKey: 'automations.freqMonthly' },
  { value: 'cron', labelKey: 'automations.freqCron' },
];

/** Weekday labels, Sunday first (cron numbering). */
export const WEEKDAY_LABEL_KEYS: readonly TranslationKey[] = [
  'automations.weekdaySun',
  'automations.weekdayMon',
  'automations.weekdayTue',
  'automations.weekdayWed',
  'automations.weekdayThu',
  'automations.weekdayFri',
  'automations.weekdaySat',
];

export function buildCron(s: ScheduleState): string {
  if (s.freq === 'cron') return s.raw;
  const [h, m] = s.time.split(':').map((n) => parseInt(n, 10));
  const min = Number.isNaN(m) ? 0 : m;
  const hr = Number.isNaN(h) ? 0 : h;
  switch (s.freq) {
    case 'daily':
      return `${min} ${hr} * * *`;
    case 'weekdays':
      return `${min} ${hr} * * 1-5`;
    case 'weekly': {
      const days = [...s.weekdays].sort((a, b) => a - b);
      return `${min} ${hr} * * ${days.length ? days.join(',') : '1'}`;
    }
    case 'monthly':
      return `${min} ${hr} ${s.monthDay} * *`;
  }
}

export function parseCron(cron: string): ScheduleState {
  const fallback: ScheduleState = { freq: 'cron', time: '09:00', weekdays: [1], monthDay: 1, raw: cron };
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return fallback;
  const [min, hr, dom, mon, dow] = parts as [string, string, string, string, string];
  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hr) || mon !== '*') return fallback;
  const time = `${hr.padStart(2, '0')}:${min.padStart(2, '0')}`;
  const base = { time, weekdays: [1], monthDay: 1, raw: cron };
  if (dom === '*' && dow === '*') return { ...base, freq: 'daily' };
  if (dom === '*' && dow === '1-5') return { ...base, freq: 'weekdays' };
  if (dom === '*' && /^[0-7](,[0-7])*$/.test(dow)) {
    const weekdays = [...new Set(dow.split(',').map((d) => parseInt(d, 10) % 7))].sort((a, b) => a - b);
    return { ...base, freq: 'weekly', weekdays };
  }
  if (dow === '*' && /^\d{1,2}$/.test(dom)) {
    const day = parseInt(dom, 10);
    if (day >= 1 && day <= 31) return { ...base, freq: 'monthly', monthDay: day };
  }
  return fallback;
}

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** One line describing a builder schedule (empty for raw cron). */
export function describeSchedule(s: ScheduleState, t: Translate): string {
  switch (s.freq) {
    case 'daily':
      return t('automations.descDaily', { time: s.time });
    case 'weekdays':
      return t('automations.descWeekdays', { time: s.time });
    case 'weekly': {
      const days = (s.weekdays.length ? s.weekdays : [1]).map((d) => t(WEEKDAY_LABEL_KEYS[d]!)).join(', ');
      return t('automations.descWeekly', { days, time: s.time });
    }
    case 'monthly':
      return t('automations.descMonthly', { day: s.monthDay, time: s.time });
    case 'cron':
      return '';
  }
}

/** The browser's IANA zone (the default for new schedules). */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
