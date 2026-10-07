/**
 * "Update my instructions?" card — a Bot proposed a change to its own
 * standing instructions (`self.propose_instructions`). The member sees the
 * reason and a line diff against the current text, may edit the proposal, and
 * accepts or declines; nothing is written until they accept (requests.ts).
 */

import { useMemo, useState } from 'react';
import type { BotInstructionsUpdatePayload, BotRequestView } from '@greenhouse/types/bots';
import { BOT_INSTRUCTIONS_MAX } from '@greenhouse/types/bots';
import { ArtifactCard, ArtifactCardActions } from '../chat/artifact-card';
import { Button, Textarea } from '../ui';
import { Pencil } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { useBotsStore } from './bots-store';
import { useRequestDecision, type RequestCardCallbacks } from './request-decision';
import { ExpiredFooter, useSettledStatus } from './request-card-parts';
import type { BotLookup } from './transcript-rows';

type DiffLine = { kind: 'same' | 'removed' | 'added'; text: string };

/**
 * A readable line diff without a diff library: lines present in only one
 * side are marked, common lines kept in order (set membership — good enough
 * for instructions, which are short and line-structured).
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const old = before.split('\n');
  const next = after.split('\n');
  const oldSet = new Set(old);
  const nextSet = new Set(next);
  const out: DiffLine[] = [];
  for (const line of old) if (!nextSet.has(line)) out.push({ kind: 'removed', text: line });
  for (const line of next) out.push({ kind: oldSet.has(line) ? 'same' : 'added', text: line });
  return out;
}

export function InstructionsUpdateCard({
  request,
  lookup,
  onSettled,
  onStale,
  onAskAgain,
}: RequestCardCallbacks & { request: BotRequestView; lookup: BotLookup; onAskAgain: (botId: string) => void }) {
  const t = useT();
  const payload = request.payload as BotInstructionsUpdatePayload;
  const name = lookup(request.bot_id)?.name ?? t('bots.deletedBot');
  const { busy, decide } = useRequestDecision(request, { onSettled, onStale });
  const { pending, expired, status } = useSettledStatus(request);
  const loadBots = useBotsStore((state) => state.loadBots);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(payload.instructions ?? '');
  const current = payload.current ?? '';
  const diff = useMemo(() => lineDiff(current, draft), [current, draft]);

  const accept = async () => {
    const text = draft.trim();
    const outcome = await decide(
      text && text !== payload.instructions ? { decision: 'approve', instructions: text } : { decision: 'approve' },
    );
    // The Bot has a new version: refresh the directory the drawer and pickers read.
    if (outcome.ok) void loadBots().catch(() => undefined);
  };

  return (
    <ArtifactCard
      icon={<Pencil size={14} />}
      title={t('bots.requests.instructionsTitle', { name })}
      meta={payload.reason}
      status={status}
      tone={pending ? 'accent' : 'neutral'}
      collapsed={!pending && !expired && !open}
      onToggle={pending || expired ? undefined : () => setOpen((value) => !value)}
      footer={
        pending ? (
          <ArtifactCardActions>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide({ decision: 'deny' })}>
              {t('bots.requests.instructionsDecline')}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing((value) => !value)}>
              {editing ? t('bots.requests.instructionsPreview') : t('bots.requests.instructionsEdit')}
            </Button>
            <Button
              size="sm"
              disabled={busy || !draft.trim()}
              onClick={() => void accept()}
              data-testid="bots-instructions-accept"
            >
              {t('bots.requests.instructionsAccept')}
            </Button>
          </ArtifactCardActions>
        ) : (
          <ExpiredFooter request={request} onAskAgain={onAskAgain} />
        )
      }
    >
      <div className="space-y-2" data-testid="bots-instructions-card">
        <p className="text-xs text-fg-muted">{t('bots.requests.instructionsHint')}</p>
        {editing && pending ? (
          <Textarea
            value={draft}
            maxLength={BOT_INSTRUCTIONS_MAX}
            rows={6}
            onChange={(event) => setDraft(event.target.value)}
            aria-label={t('bots.requests.instructionsEdit')}
          />
        ) : (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-edge bg-surface-sunken p-2 text-[11px] leading-5">
            {diff.map((line, index) => (
              <div
                key={index}
                className={
                  line.kind === 'added'
                    ? 'bg-success-subtle text-success'
                    : line.kind === 'removed'
                      ? 'bg-danger-subtle text-danger line-through'
                      : 'text-fg-secondary'
                }
              >
                {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '− ' : '  '}
                {line.text || ' '}
              </div>
            ))}
          </pre>
        )}
      </div>
    </ArtifactCard>
  );
}
