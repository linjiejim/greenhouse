/**
 * Pieces every request card shares: the status tag (waiting / settled), the
 * "Ask again" footer of an expired card, and the server-derived detail list.
 */

import type { BotRequestView } from '@greenhouse/types/bots';
import { ArtifactCardActions } from '../chat/artifact-card';
import { useT } from '../../lib/i18n';
import { settledLabelKey } from './request-decision';
import { InlineAction } from './transcript-rows';

/** Shared settled-state footer: expired cards can be re-asked, the rest just say what happened. */
export function useSettledStatus(request: BotRequestView) {
  const t = useT();
  const pending = request.status === 'pending';
  return {
    pending,
    /** Expired cards stay open to say so (approvals and tasks also offer "Ask again"). */
    expired: request.status === 'expired',
    status: pending
      ? { label: t('bots.requests.waiting'), tone: 'warning' as const }
      : {
          label: t(settledLabelKey(request)),
          tone:
            request.status === 'resolved'
              ? ('success' as const)
              : request.status === 'denied'
                ? ('danger' as const)
                : ('neutral' as const),
        },
  };
}

export function ExpiredFooter({
  request,
  onAskAgain,
}: {
  request: BotRequestView;
  onAskAgain: (botId: string) => void;
}) {
  const t = useT();
  if (request.status !== 'expired' || !request.bot_id) return null;
  const botId = request.bot_id;
  return (
    <ArtifactCardActions>
      <span className="text-xs">
        <InlineAction onClick={() => onAskAgain(botId)}>{t('bots.requests.askAgain')}</InlineAction>
      </span>
    </ArtifactCardActions>
  );
}

/** `…(+N more characters)`: the server cut a long value (apps/api/src/bots/engine/tools-assembly.ts). */
const MORE_CHARACTERS = /…\(\+(\d+) more characters\)$/;
/** `+K more field(s)` on a `…` row: fields past the card's total budget, counted instead of dropped. */
const MORE_FIELDS = /^\+(\d+) more fields?$/;

/**
 * What the member is asked to allow, shown whole: a long value (a message
 * body, a command) wraps and scrolls inside its row instead of being cut to
 * one line, and the server's truncation markers read as a quiet note in the
 * member's language rather than as part of the value.
 */
export function DetailList({ rows }: { rows: Array<{ label: string; value: string }> }) {
  const t = useT();
  if (rows.length === 0) return null;
  const shown: typeof rows = [];
  let hiddenFields: number | null = null;
  for (const row of rows) {
    const match = row.label === '…' ? MORE_FIELDS.exec(row.value) : null;
    if (match) hiddenFields = Number(match[1]);
    else shown.push(row);
  }
  return (
    <div className="space-y-1" data-testid="bots-detail-list">
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {shown.map((row, index) => {
          const cut = MORE_CHARACTERS.exec(row.value);
          return (
            <div key={`${index}:${row.label}`} className="contents">
              <dt className="text-fg-faint">{row.label}</dt>
              <dd className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-medium text-fg-secondary">
                {cut ? row.value.slice(0, cut.index) : row.value}
                {cut && (
                  <span className="font-normal text-fg-faint">
                    {'… '}
                    {t('bots.requests.moreCharacters', { count: cut[1] })}
                  </span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      {hiddenFields !== null && (
        <p className="text-[11px] text-fg-faint">{t('bots.requests.moreFields', { count: hiddenFields })}</p>
      )}
    </div>
  );
}
