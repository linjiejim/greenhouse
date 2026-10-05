/**
 * The "From an Agent" step of New Bot: the member's custom Agents, one tap to
 * snapshot one into the Bot form (see agent-snapshot.ts).
 */

import type { Profile } from '@greenhouse/types/api';
import { AgentAvatar } from '../chat/agent-avatar';
import { useT } from '../../lib/i18n';

/** Agents a member can start a Bot from: custom ones (system presets are not personas). */
export function snapshotableAgents(profiles: readonly Profile[]): Profile[] {
  return profiles.filter((profile) => profile.is_custom && profile.lifecycle_status !== 'archived');
}

export function AgentPicker({ agents, onPick }: { agents: Profile[]; onPick: (agent: Profile) => void }) {
  const t = useT();
  return (
    <div data-testid="bots-agent-picker">
      <p className="mb-3 text-sm text-fg-muted">{t('bots.gallery.pickAgent')}</p>
      <ul className="max-h-[50vh] space-y-1 overflow-y-auto">
        {agents.map((agent) => (
          <li key={agent.id}>
            <button
              type="button"
              onClick={() => onPick(agent)}
              className="flex w-full items-center gap-3 rounded-lg border border-transparent px-2 py-2 text-left transition-colors hover:border-primary-edge hover:bg-primary-subtle"
            >
              <AgentAvatar profile={agent} size="sm" animate={false} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-fg" title={agent.name}>
                  {agent.name}
                </span>
                {(agent.purpose || agent.description) && (
                  <span
                    className="block truncate text-xs text-fg-faint"
                    title={agent.purpose || agent.description || ''}
                  >
                    {agent.purpose || agent.description}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
