/**
 * Transient Mission updates in the transcript while a run is active.
 *
 * The event journal is the only live source for sandbox assistant messages.
 * They belong in the reading flow, not inside the compact progress dock. Once
 * the run settles, the durable outcome message replaces this transient view.
 */

import { useMemo } from 'react';
import type { CloudAgentEvent } from '../../lib/api/cloud-agent';
import { useT } from '../../lib/i18n';
import { formatDate, safeParse } from '../../lib/utils';
import { Cloud } from '../../lib/icons';
import { RichMarkdown } from '../rich-markdown';

export interface MissionAssistantUpdate {
  seq: number;
  text: string;
  model?: string;
  createdAt: string;
}

export function extractMissionAssistantUpdates(events: CloudAgentEvent[]): MissionAssistantUpdate[] {
  const updates: MissionAssistantUpdate[] = [];
  for (const event of events) {
    if (event.type !== 'message.assistant') continue;
    const payload = safeParse<Record<string, unknown>>(event.payload, {});
    if (typeof payload.text !== 'string' || !payload.text.trim()) continue;
    updates.push({
      seq: event.seq,
      text: payload.text,
      model: typeof payload.model === 'string' && payload.model ? payload.model : undefined,
      createdAt: event.created_at,
    });
  }
  return updates;
}

export function MissionProgressMessages({ events, active }: { events: CloudAgentEvent[]; active: boolean }) {
  const t = useT();
  const updates = useMemo(() => extractMissionAssistantUpdates(events), [events]);
  if (!active) return null;

  if (updates.length === 0) {
    return (
      <div className="flex max-w-[90%] items-center gap-2 py-1 text-xs text-fg-faint" data-testid="mission-working">
        <span className="h-2 w-2 animate-pulse rounded-full bg-primary-500" />
        <span>{t('cloudAgent.missionWorking')}</span>
      </div>
    );
  }

  return (
    <div className="max-w-[90%] space-y-3" data-testid="mission-progress-messages">
      {updates.map((update) => (
        <div key={update.seq} className="animate-fade-in">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] text-fg-faint">
            <Cloud size={12} className="text-primary-fg" />
            <span className="font-medium text-fg-muted">{t('cloudAgent.missionUpdate')}</span>
            {update.model && <span>· {update.model}</span>}
            <span className="ml-auto">{formatDate(update.createdAt)}</span>
          </div>
          <RichMarkdown content={update.text} compact linkTarget="new-window" />
        </div>
      ))}
    </div>
  );
}
