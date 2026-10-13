import { PlantAvatar } from '@greenhouse/ui/components/plant-avatar';
import type { Agent } from '@greenhouse/contract';

/**
 * An Agent's plant. Rows print the name, so the avatar is decorative unless `label` is given. Its
 * face follows `state`, but only an Agent that is answering moves (AGNT-04).
 */
export function AgentAvatar({
  agent,
  size,
  label,
  state,
}: {
  agent: Pick<Agent, 'id' | 'avatar' | 'template_key'>;
  size: number;
  label?: string;
  state?: 'thinking' | 'waiting' | 'error';
}) {
  return (
    <PlantAvatar
      avatar={agent.avatar}
      templateKey={agent.template_key}
      stableId={agent.id}
      size={size}
      state={state}
      animate={state === 'thinking' ? undefined : false}
      label={label}
    />
  );
}
