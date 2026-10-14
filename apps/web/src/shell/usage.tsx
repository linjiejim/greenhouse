/** Usage numbers as content.md writes them: tokens compact (1.2M tokens), cost with its unit. */

import { cx } from '../lib/cx';
import { useI18n } from '../lib/i18n';

export function formatTokens(tokens: number, locale: string): string {
  if (tokens >= 1_000_000)
    return `${(tokens / 1_000_000).toLocaleString(locale, { maximumFractionDigits: 1 })}M tokens`;
  if (tokens >= 10_000) return `${(tokens / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })}K tokens`;
  return `${tokens.toLocaleString(locale)} tokens`;
}

export const formatCost = (micros: number, locale: string) =>
  `$${(micros / 1_000_000).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The share of prompt tokens read from the vendor's cache; a dash before any model call. */
export const formatHitRate = (rate: number | null, locale: string) =>
  rate === null ? '—' : rate.toLocaleString(locale, { style: 'percent', maximumFractionDigits: 0 });

export function BudgetBar({ spent, limit, unit }: { spent: number; limit: number; unit: 'tokens' | 'usd_micros' }) {
  const { t, locale } = useI18n();
  const share = limit > 0 ? Math.min(1, spent / limit) : 0;
  const show = (value: number) => (unit === 'tokens' ? formatTokens(value, locale) : formatCost(value, locale));
  return (
    <div className="app-budget">
      <div className="app-budget-text">
        <span>{t('usage.budget')}</span>
        <span>
          {show(spent)} / {show(limit)}
        </span>
      </div>
      <div
        className={cx('app-budget-bar', share >= 1 && 'is-over', share >= 0.8 && share < 1 && 'is-near')}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(spent, limit)}
        aria-label={t('usage.budget')}
      >
        <span style={{ width: `${share * 100}%` }} />
      </div>
    </div>
  );
}
