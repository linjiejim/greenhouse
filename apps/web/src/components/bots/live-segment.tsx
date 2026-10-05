/**
 * One Bot's live turn inside a multi-speaker run — Chat's streaming bubble
 * under a speaker header, with its memory receipts and, if the turn failed,
 * the reason and a retry.
 */

import type { BotStreamSegment } from '../../lib/session-manager';
import { StreamingMessageBubble } from '../chat/streaming-message-bubble';
import { AlertTriangle } from '../../lib/icons';
import { useI18n } from '../../lib/i18n';
import { MemoryReceipts, memoryReceiptsFromCalls } from './memory-receipts';
import { InlineAction, SpeakerHeader, type BotLookup } from './transcript-rows';

export function LiveSegment({
  segment,
  header,
  lookup,
  onAddress,
  onOpenProfile,
  busy,
}: {
  segment: BotStreamSegment;
  header: boolean;
  lookup: BotLookup;
  onAddress: (botId: string | null, text: 'retry' | 'continue') => void;
  onOpenProfile?: (botId: string) => void;
  busy: boolean;
}) {
  const { t } = useI18n();
  const bot = lookup(segment.botId);
  const name = bot?.name ?? t('bots.deletedBot');
  const finishedCalls = segment.toolCalls.filter((call) => call.status === 'done');
  const empty = !segment.text && !segment.reasoning && segment.toolCalls.length === 0;
  return (
    <div data-testid="bots-live-segment" data-bot-id={segment.botId}>
      {header && <SpeakerHeader bot={bot} fallbackName={name} onOpenProfile={onOpenProfile} />}
      {!(segment.status !== 'streaming' && empty) && (
        <StreamingMessageBubble
          text={segment.text}
          reasoning={segment.reasoning}
          toolCalls={segment.toolCalls}
          isStreaming={segment.status === 'streaming'}
        />
      )}
      <MemoryReceipts receipts={memoryReceiptsFromCalls(finishedCalls)} botId={segment.botId} botName={name} />
      {segment.status === 'error' && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-danger">
          <AlertTriangle size={12} aria-hidden="true" />
          <span>{segment.error || t('bots.transcript.turnFailed', { name })}</span>
          <InlineAction disabled={busy} onClick={() => onAddress(segment.botId, 'retry')}>
            {t('bots.transcript.retry')}
          </InlineAction>
        </div>
      )}
      {segment.status === 'stopped' && <p className="mt-1 text-[11px] text-fg-faint">{t('bots.transcript.stopped')}</p>}
    </div>
  );
}
