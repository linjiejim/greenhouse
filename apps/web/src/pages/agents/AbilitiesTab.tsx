/**
 * 能力 (AGNT-07): whether the Agent may ask to change shared things. Every change still waits
 * for the member's approval. Tool detail stays out of the way.
 */

import { Switch } from '@greenhouse/ui/kit';
import type { AgentDetail } from '@greenhouse/contract';
import { useNotify } from '../../app/notify';
import { useUpdateAgent } from '../../data/agents';
import { useI18n } from '../../lib/i18n';

export function AbilitiesTab({ agent }: { agent: AgentDetail }) {
  const { t } = useI18n();
  const notify = useNotify();
  const update = useUpdateAgent(agent.id);
  return (
    <section className="app-settings-group" aria-label={t('agents.tabAbilities')}>
      <div className="app-setting-row">
        <div className="app-setting-text">
          <strong>{t('agents.write')}</strong>
          <span>{t('agents.writeHint')}</span>
        </div>
        <Switch
          label={t('agents.write')}
          checked={agent.write}
          disabled={!!agent.archived_at || update.isPending}
          onChange={(write) => update.mutate({ write }, { onError: () => notify(t('common.error')) })}
        />
      </div>
      <div className="app-setting-row">
        <div className="app-setting-text">
          <strong>{t('agents.tools')}</strong>
          <span>{agent.tools === null ? t('agents.toolsAll') : agent.tools.join('、')}</span>
        </div>
      </div>
    </section>
  );
}
