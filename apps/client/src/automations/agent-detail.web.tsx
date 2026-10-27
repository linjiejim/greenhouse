/**
 * One custom agent in the Automations place's main column (wide browser): its look and
 * description, the facts that shape a run (model, tools, steps, version, connectors, risk), team
 * availability, its instructions and the automations of mine that run as it. Mine: edit,
 * duplicate, delete; one the team shares: duplicate. A super switches team availability here.
 */
import React, { useState } from 'react';
import { setCustomAgentShared } from '../api/profiles';
import { captureIdentity } from '../data/identity';
import { useT } from '../lib/i18n';
import { alertError } from '../ui/dialogs';
import { Icon } from '../ui/core';
import { NativeMenu } from '../ui/menu.web';
import { Place, PlaceEmpty, PlaceRow } from '../ui/place.web';
import { PlantAvatar } from '../ui/plant-avatar';
import { resolvePlantAvatar } from '../ui/plant-avatar/plant-ids';
import { agentRowId, type CustomAgent } from './agents';
import type { Automation } from './model';
import { scheduleLabel } from './words';
import './automations.css';

export function AgentDetail({
  agent,
  mine,
  isSuper,
  loading,
  error,
  retry,
  usedBy,
  empty,
  onEdit,
  onDuplicate,
  onDelete,
  onChanged,
  onOpenAutomation,
}: {
  agent: CustomAgent | null;
  mine: boolean;
  isSuper: boolean;
  loading: boolean;
  error: string | null;
  retry: () => void;
  usedBy: Automation[];
  /** The "no agents yet" state, when there are none at all. */
  empty: React.ReactNode;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onChanged: (agent: CustomAgent) => void;
  onOpenAutomation: (id: string) => void;
}) {
  const t = useT();
  const [sharing, setSharing] = useState(false);
  if (!agent)
    return (
      <Place title={t('agents.section')}>
        <div className="gh-place-scroll">{empty ?? <PlaceEmpty loading={loading} error={error} retry={retry} />}</div>
      </Place>
    );
  const look = resolvePlantAvatar(agent.avatar, { stableId: agent.id });
  const share = async (next: boolean) => {
    if (sharing) return;
    const current = captureIdentity();
    setSharing(true);
    const r = await setCustomAgentShared(agentRowId(agent.id), next);
    if (!current()) return;
    setSharing(false);
    if (!r.ok) {
      alertError(t('agents.shareFailed'), r.message);
      return;
    }
    onChanged(r.data);
  };
  const facts: [string, string][] = [
    [t('agents.model'), agent.model_id ?? '—'],
    [t('agents.tools'), t('agents.toolsCount', { n: agent.tools?.length ?? 0 })],
    [t('agents.maxSteps'), String(agent.max_steps ?? '—')],
    [t('agents.version'), t('agents.versionValue', { n: agent.current_version ?? 1 })],
    [
      t('agents.connectors'),
      agent.connectors ? t('agents.connectorsSome', { n: agent.connectors.length }) : t('agents.connectorsAll'),
    ],
    [t('agents.risk'), t(`agents.riskLevel.${agent.risk_level ?? 'medium'}`)],
    ...(agent.purpose ? [[t('agents.purpose'), agent.purpose] as [string, string]] : []),
    ...(agent.audience ? [[t('agents.audience'), agent.audience] as [string, string]] : []),
    ...(agent.usage?.total_calls ? [[t('agents.calls'), String(agent.usage.total_calls)] as [string, string]] : []),
  ];
  return (
    <Place
      title={agent.name}
      actions={
        <>
          {mine ? <button onClick={onEdit}>{t('agents.edit')}</button> : null}
          <button className={mine ? undefined : 'gh-primary'} onClick={onDuplicate}>
            {t('agents.duplicate')}
          </button>
          {mine ? (
            <NativeMenu
              items={[{ id: 'delete', title: t('agents.delete'), icon: 'trash', destructive: true }]}
              onSelect={() => onDelete()}
            >
              <button aria-label={t('automations.moreActions')}>
                <Icon name="more" size={18} />
              </button>
            </NativeMenu>
          ) : null}
        </>
      }
    >
      <div className="gh-place-scroll">
        <div className="gh-agent" data-testid="agent-detail">
          <header className="gh-agent-head">
            <PlantAvatar plant={look.plant} tint={look.tint} seed={look.seed} size={56} animate={false} />
            <div>
              <h1>{agent.name}</h1>
              <p>
                {agent.description ||
                  (mine
                    ? t('agents.yours')
                    : agent.owner_nickname
                      ? t('agents.sharedBy', { name: agent.owner_nickname })
                      : t('agents.sharedByTeam'))}
              </p>
            </div>
          </header>
          <dl className="gh-agent-facts">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd title={value}>{value}</dd>
              </div>
            ))}
          </dl>
          {isSuper ? (
            <label className="gh-agent-share">
              <span>
                <strong>{t('agents.share')}</strong>
                <p>{t('agents.shareHintSuper')}</p>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="gh-auto-switch"
                checked={agent.is_shared === true}
                aria-checked={agent.is_shared === true}
                disabled={sharing}
                onChange={(e) => void share(e.target.checked)}
              />
            </label>
          ) : mine ? (
            <div className="gh-agent-share">
              <span>
                <strong>{agent.is_shared ? t('agents.sharedByTeam') : t('agents.share')}</strong>
                {agent.is_shared ? null : <p>{t('agents.shareHint')}</p>}
              </span>
              {agent.is_shared ? <Icon name="users" size={18} /> : null}
            </div>
          ) : null}
          <h2 className="gh-agent-section-title">{t('agents.instructions')}</h2>
          <div className="gh-agent-prompt">{agent.system_prompt || '—'}</div>
          <h2 className="gh-agent-section-title">{t('agents.usedBy')}</h2>
          {usedBy.length ? (
            <div className="gh-agent-uses" data-place-list>
              {usedBy.map((task) => (
                <PlaceRow
                  key={task.id}
                  title={task.name}
                  detail={scheduleLabel(task.schedule, task.timezone)}
                  icon="clock"
                  onOpen={() => onOpenAutomation(task.id)}
                />
              ))}
            </div>
          ) : (
            <p className="gh-auto-hint">{t('agents.usedByNone')}</p>
          )}
        </div>
      </div>
    </Place>
  );
}
