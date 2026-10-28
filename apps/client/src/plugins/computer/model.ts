/**
 * The member's cloud computer (`GET /api/computer`) as people read it: one state word, the money
 * in dollars and the actions the state allows (./screen*.tsx). React-free.
 */

/** One computer, as `computerView()` in plugins/computer/api/service.ts answers it. */
export interface ComputerView {
  id: string;
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'failed' | 'lost';
  started_at: string;
  last_used_at: string;
  stopped_at: string | null;
  stop_reason: string | null;
  minutes_billed: number;
  client: string;
}

/** `GET /api/computer` (packages/types/src/metering.ts `MyComputerReport`). */
export interface MyComputerReport {
  enabled: boolean;
  configured: boolean;
  price_per_minute_usd: number | null;
  idle_minutes: number;
  computer: ComputerView | null;
  minutes_this_month: number;
  period: { start: string; end: string };
}

/**
 * `off`: the station's switch is off; `unconfigured`: on but without a provider key; `stopped`:
 * ready, nothing running; the rest are the computer's own transitions. A computer still running
 * after the switch went off shows as running until the sweep stops it.
 */
export type ComputerState = 'off' | 'unconfigured' | 'stopped' | 'starting' | 'running' | 'stopping';

const LIVE = new Set<ComputerView['status']>(['starting', 'running', 'stopping']);

export function computerState(report: MyComputerReport): ComputerState {
  const status = report.computer?.status;
  if (status && LIVE.has(status)) return status as ComputerState;
  if (!report.enabled) return 'off';
  if (!report.configured) return 'unconfigured';
  return 'stopped';
}

/** How often a starting or stopping computer is looked at again. */
export const TRANSITION_POLL_MS = 3000;

export const canStart = (state: ComputerState) => state === 'stopped';
/** The station stops only a running computer; starting and stopping ones finish on their own. */
export const canStop = (state: ComputerState) => state === 'running';

/**
 * USD as money in the app's locale (`$0.13`, `US$0.13`): cents, except a `unit` price (per
 * minute) or an amount under a cent keeps two significant digits (up to six decimals), so it
 * never reads as zero.
 */
export function formatUsd(usd: number, locale: string, unit = false): string {
  const size = Math.abs(usd);
  const fine = size > 0 && size < (unit ? 1 : 0.01);
  const digits = fine ? Math.min(6, Math.max(2, Math.ceil(-Math.log10(size)) + 1)) : 2;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  }).format(usd);
}

/** The price lines: per minute, per hour and this month's minutes at that price; null when unpriced. */
export function computerCosts(report: MyComputerReport, locale: string) {
  const price = report.price_per_minute_usd;
  if (price === null || !Number.isFinite(price)) return null;
  return {
    perMinute: formatUsd(price, locale, true),
    perHour: formatUsd(price * 60, locale),
    thisMonth: formatUsd(price * report.minutes_this_month, locale),
  };
}

/** Why `POST /api/computer/start` refused, as a key of the screen's words; null for anything else. */
export function startRefusal(code: string): 'off' | 'unconfigured' | 'full' | 'busy' | 'budget' | null {
  if (code === 'disabled') return 'off';
  if (code === 'not_configured') return 'unconfigured';
  if (code === 'full') return 'full';
  if (code === 'busy') return 'busy';
  if (code === 'usage_budget_exceeded') return 'budget';
  return null;
}
