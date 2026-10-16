import { PlantAvatar, usePlantWorkState } from '@greenhouse/ui/components/plant-avatar';
import type { PlantStateInput } from '@greenhouse/types';
import { useStream } from '../data/streams';
import type { Agent, Message } from '@greenhouse/contract';

/**
 * An Agent's plant. Rows print the name, so the avatar is decorative unless `label` is given. Its
 * face follows `state`, but only an Agent that is answering moves (AGNT-04).
 */
export function AgentAvatar({
  agent,
  size,
  label,
  state,
  animate,
}: {
  agent: Pick<Agent, 'id' | 'avatar' | 'template_key'>;
  size: number;
  label?: string;
  state?: PlantStateInput;
  animate?: boolean;
}) {
  return (
    <PlantAvatar
      avatar={agent.avatar}
      templateKey={agent.template_key}
      stableId={agent.id}
      size={size}
      state={state}
      animate={animate ?? (size >= 80 || (state !== undefined && state !== 'idle'))}
      label={label}
    />
  );
}

export function WorkingAgentAvatar({
  agent,
  size,
  working,
  waiting,
  reply,
  sleeping,
  greeting = true,
}: {
  agent: Parameters<typeof AgentAvatar>[0]['agent'];
  size: number;
  working?: boolean;
  waiting?: boolean;
  reply?: Message;
  sleeping?: boolean;
  greeting?: boolean;
}) {
  const stream = useStream(reply?.id ?? '');
  const state = usePlantWorkState({
    working,
    streaming: reply?.status === 'streaming',
    hasText: !!(stream?.text || reply?.content),
    toolRunning: stream?.steps.some((step) => step.status === 'running'),
    waiting,
    failed: reply?.status === 'failed',
    sleeping,
    greeting,
  });
  return <AgentAvatar agent={agent} size={size} state={state} />;
}
