/** Member-facing dates share the calendar words used by agenda and timeline views. */
import { parseMs } from '../data/time';
import { localeOf, t } from '../lib/i18n';
import { calendarDateLabel } from '../lib/time-words';
import { useAuth } from '../store/auth';
import { usePrefs } from '../store/prefs';
import { cellText as rawCellText } from './model';

export const cellText: typeof rawCellText = (field, value, page, names) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if ('error' in value) return t('work.computationFailed');
    if ('pending' in value) return t('common.loading');
  }
  if ((field.type === 'date' || field.type === 'datetime') && typeof value === 'string') {
    const date = calendarDateLabel(value);
    if (!date) return '';
    if (field.type === 'date') return date;
    const ms = parseMs(value);
    if (!Number.isFinite(ms)) return '';
    const time = new Intl.DateTimeFormat(localeOf(usePrefs.getState().lang), {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: useAuth.getState().user?.timezone,
    }).format(new Date(ms));
    return `${date} ${time}`;
  }
  return rawCellText(field, value, page, names);
};
