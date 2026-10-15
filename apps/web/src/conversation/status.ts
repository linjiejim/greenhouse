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
    case 'superseded':
      return { word: 'status.superseded', tone: 'neutral' };
    case 'withdrawn':
      return { word: 'status.withdrawn', tone: 'neutral' };
    case 'canceled':
      return { word: 'status.canceled', tone: 'neutral' };
  }
}

/** Approval details keep the server's words and optional rendering hints together. */
export function detailRows(
  details: unknown,
): { label: string; value: string; format?: 'markdown'; chips?: string[] }[] {
  const text = (value: unknown, depth = 0): string => {
    if (value === null || value === undefined) return '—';
    if (depth > 5) return '…';
    if (Array.isArray(value)) return value.map((value) => text(value, depth + 1)).join(' · ');
    if (typeof value === 'object')
      return Object.entries(value)
        .map(([key, value]) => `${key}: ${text(value, depth + 1)}`)
        .join('\n');
    return String(value);
  };
  if (Array.isArray(details))
    return details.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== 'object' || !('label' in entry)) return [];
      const row = entry as { label: unknown; value?: unknown; format?: unknown; chips?: unknown };
      return [
        {
          label: text(row.label),
          value: text(row.value ?? ''),
          ...(row.format === 'markdown' ? { format: 'markdown' as const } : {}),
          ...(Array.isArray(row.chips)
            ? { chips: row.chips.filter((chip): chip is string => typeof chip === 'string') }
            : {}),
        },
      ];
    });
  if (details && typeof details === 'object')
    return Object.entries(details).map(([label, value]) => ({ label, value: text(value) }));
  return [];
}
