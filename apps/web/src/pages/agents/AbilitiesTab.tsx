/**
 * 能力 (AGNT-07, AGNT-12): the model it answers with (only when there is more than one to pick
 * from), and whether it may ask to change shared things; every change still waits for the
 * member's approval. Tool detail stays out of the way.
 */

import { Select, Switch } from '@greenhouse/ui/kit';
import type { AgentDetail } from '@greenhouse/contract';
import { useNotify } from '../../app/notify';
import { useModelChoices, useUpdateAgent } from '../../data/agents';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';

export function AbilitiesTab({ agent }: { agent: AgentDetail }) {
  const { t } = useI18n();
  const notify = useNotify();
  const update = useUpdateAgent(agent.id);
  const choices = useModelChoices().data?.items ?? [];
  const aliases = [
    { value: 'default', label: t('agents.modelDefault') },
    { value: 'strong', label: t('agents.modelStrong') },
    { value: 'fast', label: t('agents.modelFast') },
  ];
  const options = [
    ...aliases,
    ...choices.map((choice) => ({
      value: choice.ref,
      label: choice.label,
      description: choice.personal ? t('agents.modelMine', { name: choice.instance }) : choice.instance,
    })),
  ];
  // A model that went away still shows, so the picker never looks empty.
  if (!options.some((option) => option.value === agent.model)) options.push({ value: agent.model, label: agent.model });
  return (
    <section className="app-settings-group" aria-label={t('agents.tabAbilities')}>
      {choices.length > 1 && (
        <div className="app-setting-row">
          <div className="app-setting-text">
            <strong>{t('agents.model')}</strong>
            <span>{t('agents.modelHint')}</span>
          </div>
          <Select
            label={t('agents.model')}
            value={agent.model}
            options={options}
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
