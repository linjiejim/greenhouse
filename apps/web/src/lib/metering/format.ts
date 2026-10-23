/**
 * Money and label formatting for the metering pages. Amounts travel as USD
 * micros (1 USD = 1_000_000) and are only turned into dollars for display.
 */

import type { MeteredService, MeteringClient, ServiceUnitKind } from '@greenhouse/types/metering';
import { METERED_SERVICES, METERING_CLIENTS } from '@greenhouse/types/metering';
import type { TranslationKey } from '../i18n';

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

/** Share of a limit used, 0..1+ (a zero limit with spend reads as fully used). */
export function usedFraction(spent: number, limit: number): number {
  if (limit <= 0) return spent > 0 ? 1 : 0;
  return spent / limit;
}

export function serviceLabelKey(service: string): TranslationKey | null {
  return (METERED_SERVICES as readonly string[]).includes(service)
    ? (`metering.serviceNames.${service as MeteredService}` as TranslationKey)
    : null;
}

export function clientLabelKey(client: string): TranslationKey {
  return (METERING_CLIENTS as readonly string[]).includes(client)
    ? (`metering.clientNames.${client as MeteringClient}` as TranslationKey)
    : 'metering.clientNames.unknown';
}

export function perUnitKey(unit: ServiceUnitKind): TranslationKey | null {
  return unit === 'token' ? null : (`metering.perUnit.${unit}` as TranslationKey);
}

/** One page of an in-memory list for a CRUD data source: the slice, and the full count for the pager. */
export function pageOf<T>(
  items: readonly T[],
  params?: { skip?: number; limit?: number },
): { items: T[]; total: number } {
  const skip = Math.max(0, params?.skip ?? 0);
  const limit = Math.max(1, params?.limit ?? items.length);
  return { items: items.slice(skip, skip + limit), total: items.length };
}
