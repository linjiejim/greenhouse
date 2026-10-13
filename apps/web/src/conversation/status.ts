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
