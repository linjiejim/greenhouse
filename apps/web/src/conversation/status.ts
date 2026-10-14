import type { Tone } from '@greenhouse/ui/kit';
import type { NeedsYou } from '@greenhouse/contract';
import type { MessageKey } from '../i18n/zh';

/** The decision words of content.md with their tone: yellow only while it needs you. */
export function requestStatus(request: Pick<NeedsYou, 'status'>): { word: MessageKey; tone: Tone } {
  switch (request.status) {
    case 'pending':
      return { word: 'status.needsYou', tone: 'warning' };
    case 'approved':
      return { word: 'status.approved', tone: 'success' };
    case 'answered':
      return { word: 'status.done', tone: 'success' };
    case 'handed_back':
      return { word: 'status.handedBack', tone: 'success' };
    case 'rejected':
      return { word: 'status.rejected', tone: 'neutral' };
    case 'expired':
      return { word: 'status.expired', tone: 'neutral' };
    case 'canceled':
      return { word: 'status.canceled', tone: 'neutral' };
  }
}

/**
 * An approval card's details as label and value: the engine's cards carry `[{ label, value }]`
 * (engine/tools/define.ts), others a plain object of them.
 */
export function detailRows(details: unknown): [string, string][] {
  const text = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));
  if (Array.isArray(details)) {
    return details.flatMap((entry: unknown): [string, string][] =>
      entry && typeof entry === 'object' && 'label' in entry
        ? [[String((entry as { label: unknown }).label), text((entry as { value?: unknown }).value ?? '')]]
        : [],
    );
  }
  if (details && typeof details === 'object') {
    return Object.entries(details as Record<string, unknown>).map(([key, value]) => [key, text(value)]);
  }
  return [];
}
