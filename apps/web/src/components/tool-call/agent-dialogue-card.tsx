import React from 'react';
import { MessageSquare, Info, ChevronDown } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { RichMarkdown } from '../rich-markdown';
import { IconButton, Spinner } from '../ui';
import type { ArtifactCall } from './body-artifacts';

interface DialogueArtifact {
  type: 'agent_dialogue';
  dialogue_id: string;
  from_name: string;
  to_name: string;
  rounds: Array<{
    id: string;
    round: number;
    message: string;
    reply: string | null;
    status: string;
    error: string | null;
  }>;
}

/** A read-only transcript of the actual peer messages, not a handoff of the human chat. */
export function AgentDialogueCard({ call }: { call: ArtifactCall }) {
  const t = useT();
  const data = call.output as DialogueArtifact | undefined;
  if (!data)
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge bg-surface-raised p-3 text-xs text-fg-muted">
        <Spinner className="h-3 w-3" />
        {t('coworker.discussing')}
      </div>
    );
  return (
    <details
      data-testid="agent-dialogue-card"
      className="group/coworker overflow-hidden rounded-xl border border-edge bg-surface-raised"
    >
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2.5 text-xs">
        <MessageSquare size={15} className="text-primary-600" />
        <span className="min-w-0 flex-1 truncate font-medium">
          {data.from_name} ↔ {data.to_name}
        </span>
        <span className="text-fg-muted">{t('coworker.round', { round: data.rounds.length })}</span>
        <ChevronDown size={13} className="shrink-0 transition-transform group-open/coworker:rotate-180" />
        <IconButton
          size="compact"
          label={t('coworker.privateHint')}
          tooltipMode="portal"
          onClick={(event) => event.preventDefault()}
        >
          <Info size={12} />
        </IconButton>
      </summary>
      <div className="space-y-3 border-t border-edge p-3">
        {data.rounds.map((round) => (
          <section key={round.id} className="space-y-2 text-xs">
            <div className="text-[10px] text-fg-faint">{t('coworker.round', { round: round.round })}</div>
            <div className="rounded-lg bg-surface-muted p-2.5">
              <div className="mb-1 font-medium">{data.from_name}</div>
              <RichMarkdown content={round.message} compact linkTarget="new-window" />
            </div>
            <div className="rounded-lg border border-edge p-2.5">
              <div className="mb-1 font-medium">{data.to_name}</div>
              {round.reply ? (
                <RichMarkdown content={round.reply} compact linkTarget="new-window" />
              ) : (
                <p className="text-fg-muted">
                  {t(round.status === 'running' ? 'coworker.discussing' : 'coworker.failed')}
                </p>
              )}
              {round.error && <p className="mt-1 break-words text-danger">{round.error}</p>}
            </div>
          </section>
        ))}
      </div>
    </details>
  );
}
