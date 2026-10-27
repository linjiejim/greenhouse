/**
 * Numbers of the Admin place (React-free, tested). Money travels as USD micros
 * (1 USD = 1_000_000) and turns into dollars only for display, as on the classic pages.
 */
import { parseMs } from '../data/time';

export const USD_MICROS = 1_000_000;

/** `$12.34`; small amounts keep enough digits to stay non-zero (`$0.0042`). */
export function formatUsd(micros: number): string {
  const usd = micros / USD_MICROS;
  if (usd !== 0 && Math.abs(usd) < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A per-unit or per-token price in USD, as written in the config files. */
export function formatUsdPrice(usd: number): string {
  return `$${Number(usd.toFixed(6)).toString()}`;
}

/** Dollars typed by an admin → micros, or null when not a valid non-negative amount. */
export function parseUsdInput(value: string): number | null {
  const trimmed = value.trim().replace(/^\$/, '');
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return null;
  const micros = Math.round(Number(trimmed) * USD_MICROS);
  return Number.isSafeInteger(micros) ? micros : null;
}

/** A price typed by an admin (`0.15`, `$2`) → USD, or null. */
export function parsePrice(value: string): number | null {
  const trimmed = value.trim().replace(/^\$/, '');
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  return Number(trimmed);
}

/** Share of a limit used, 0..1+ (a zero limit with spend reads as fully used). */
export function usedFraction(spent: number, limit: number): number {
  if (limit <= 0) return spent > 0 ? 1 : 0;
  return spent / limit;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

export function formatDuration(ms: number): string {
  if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
  return `${ms}ms`;
}

/** The current UTC month and the five before it, newest first (`2026-10`). */
export function recentMonths(now = new Date()): string[] {
  return Array.from({ length: 6 }, (_, back) => {
    const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

export const USAGE_PERIODS = ['', '30d', '7d', '24h'] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];

/** The `since` of a usage period, or undefined for all time. */
export function periodSince(period: UsagePeriod, now = Date.now()): string | undefined {
  const hours = { '': 0, '24h': 24, '7d': 24 * 7, '30d': 24 * 30 }[period];
  return hours ? new Date(now - hours * 3_600_000).toISOString() : undefined;
}

/** Calendar date of a timestamp in the app's locale (`2026/10/27`), or null. */
export function dayLabel(value: string | null | undefined, locale: string): string | null {
  const ms = parseMs(value);
  return Number.isFinite(ms) ? new Date(ms).toLocaleDateString(locale) : null;
}

/** Date and time of a timestamp in the app's locale, or null. */
export function dateTimeLabel(value: string | null | undefined, locale: string): string | null {
  const ms = parseMs(value);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) : null;
}
