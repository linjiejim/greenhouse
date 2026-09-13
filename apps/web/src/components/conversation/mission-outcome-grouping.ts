import type { PipelineStep } from '@greenhouse/types/session';
import type { CloudAgentRun } from '../../lib/api/cloud-agent';

interface GroupableMessage {
  id: string;
  role: string;
  content: string;
  created_at: string;
  pipeline: PipelineStep[];
}

export interface GroupedMissionOutcome {
  messageId: string;
  content: string;
  createdAt: string;
}

export interface MissionOutcomeGroups {
  byOriginMessageId: Map<string, GroupedMissionOutcome>;
  groupedOutcomeMessageIds: Set<string>;
}

/**
 * Keep the outcome as its own durable message while placing it visually under
 * the assistant turn whose mission_dispatch artifact launched that run.
 * dispatch_id is the stable bridge; prompt/title matching would mis-group two
 * similar missions or a follow-up run.
 */
export function groupMissionOutcomes(
  messages: GroupableMessage[],
  runs: Pick<CloudAgentRun, 'id' | 'dispatch_id'>[],
): MissionOutcomeGroups {
  const originByDispatchId = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const step of message.pipeline) {
      const output = step.output;
      if (!output || typeof output !== 'object' || Array.isArray(output)) continue;
      const artifact = output as Record<string, unknown>;
      if (artifact.type !== 'mission_dispatch' || typeof artifact.dispatch_id !== 'string') continue;
      originByDispatchId.set(artifact.dispatch_id, message.id);
    }
  }

  const messageById = new Map(messages.map((message) => [message.id, message]));
  const byOriginMessageId = new Map<string, GroupedMissionOutcome>();
  const groupedOutcomeMessageIds = new Set<string>();
  for (const run of runs) {
    if (!run.dispatch_id) continue;
    const originMessageId = originByDispatchId.get(run.dispatch_id);
    const outcomeMessageId = `cloud-agent-outcome:${run.id}`;
    const outcome = messageById.get(outcomeMessageId);
    if (!originMessageId || !outcome || outcome.role !== 'assistant') continue;
    byOriginMessageId.set(originMessageId, {
      messageId: outcome.id,
      content: outcome.content,
      createdAt: outcome.created_at,
    });
    groupedOutcomeMessageIds.add(outcome.id);
  }
  return { byOriginMessageId, groupedOutcomeMessageIds };
}
