/**
 * 能力 (AGNT-07, AGNT-12, SKL-07): the model it answers with (only when there is more than one to
 * pick from), the skills it is equipped with, and whether it may ask to change shared things;
 * every change still waits for the member's approval. Tool detail stays out of the way.
 */

import { MultiSelect, Select, Switch } from '@greenhouse/ui/kit';
import type { AgentDetail } from '@greenhouse/contract';
import { useNotify } from '../../app/notify';
import { useUpdateAgent } from '../../data/agents';
import { useModelOptions } from '../../data/models';
import { useSkills } from '../../data/skills';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';

export function AbilitiesTab({ agent }: { agent: AgentDetail }) {
  const { t } = useI18n();
  const notify = useNotify();
  const update = useUpdateAgent(agent.id);
  const models = useModelOptions(agent.model);
  // Judged for this Agent: a skill that needs a computer it lacks cannot be equipped.
  const skills = useSkills({ agent: agent.is_main ? 'main' : agent.id });
  const skillOptions = skills.items
    .filter((skill) => skill.available || agent.skills.includes(skill.id))
    .map((skill) => ({
      value: skill.id,
      label: `/${skill.name}`,
      description: skill.available ? skill.display_name || skill.description : skill.unavailable?.message,
    }));
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
          <strong>{t('agents.skills')}</strong>
          <span>{t('agents.skillsHint')}</span>
        </div>
        <MultiSelect
          label={t('agents.skills')}
          placeholder={t('agents.skillsNone')}
          value={agent.skills}
          options={skillOptions}
          disabled={!!agent.archived_at || update.isPending}
          onChange={(next) => update.mutate({ skills: next }, { onError: (error) => notify(errorText(error, t)) })}
        />
      </div>
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
