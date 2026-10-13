/**
 * 能力 (AGNT-07, AGNT-12): the model it answers with (only when there is more than one to pick
 * from), and whether it may ask to change shared things; every change still waits for the
 * member's approval. Tool detail stays out of the way.
 */

import { Select, Switch } from '@greenhouse/ui/kit';
import type { AgentDetail } from '@greenhouse/contract';
import { useNotify } from '../../app/notify';
import { useUpdateAgent } from '../../data/agents';
import { useModelOptions } from '../../data/models';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';

export function AbilitiesTab({ agent }: { agent: AgentDetail }) {
  const { t } = useI18n();
  const notify = useNotify();
  const update = useUpdateAgent(agent.id);
  const models = useModelOptions(agent.model);
  return (
    <section className="app-settings-group" aria-label={t('agents.tabAbilities')}>
      {models.available && (
        <div className="app-setting-row">
          <div className="app-setting-text">
            <strong>{t('agents.model')}</strong>
            <span>{t('agents.modelHint')}</span>
          </div>
          <Select
            label={t('agents.model')}
            value={agent.model}
            options={models.options}
            disabled={!!agent.archived_at || update.isPending}
            onChange={(model) => update.mutate({ model }, { onError: (error) => notify(errorText(error, t)) })}
          />
        </div>
      )}
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
