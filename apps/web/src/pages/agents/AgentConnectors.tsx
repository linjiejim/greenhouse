/**
 * 可用连接器 (AGNT-07): which connectors this Agent may use. 全部 (manifest `connectors` null)
 * follows whatever its owner can use, now and later; otherwise only the picked ones. Picks save
 * as one new version when the list closes. Nothing shows while no connector is installed.
 */

import { useState } from 'react';
import { MultiSelect, Switch } from '@greenhouse/ui/kit';
import type { AgentDetail } from '@greenhouse/contract';
import { useNotify } from '../../app/notify';
import { useUpdateAgent } from '../../data/agents';
import { useMyConnections } from '../../data/connectors';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((item) => b.includes(item));

export function AgentConnectors({ agent }: { agent: AgentDetail }) {
  const { t } = useI18n();
  const notify = useNotify();
  const update = useUpdateAgent(agent.id);
  const mine = useMyConnections();
  /** Picks while the list is open, saved when it closes. */
  const [draft, setDraft] = useState<string[] | null>(null);
  const connectors = mine.data?.connectors ?? [];
  if (!connectors.length && agent.connectors === null) return null;

  const all = agent.connectors === null;
  const locked = !!agent.archived_at || update.isPending;
  const save = (connectors: string[] | null) =>
    update.mutate({ connectors }, { onError: (error) => notify(errorText(error, t)), onSettled: () => setDraft(null) });
  const usable = (id: string) =>
    mine.data?.items.some((item) => item.connector?.id === id && item.status !== 'needs_reauth') ?? false;
  return (
    <>
      <div className="app-setting-row">
        <div className="app-setting-text">
          <strong>{t('agents.connectors')}</strong>
          <span>{all ? t('agents.connectorsAll') : t('agents.connectorsSome')}</span>
        </div>
        <Switch
          label={t('agents.connectorsEvery')}
          checked={all}
          disabled={locked}
          onChange={(on) => save(on ? null : connectors.map((connector) => connector.slug))}
        />
      </div>
      {!all && (
        <div className="app-setting-row is-wide">
          <MultiSelect
            label={t('agents.connectorsPick')}
            placeholder={t('agents.connectorsNone')}
            value={draft ?? agent.connectors ?? []}
            max={4}
            disabled={locked}
            options={connectors.map((connector) => ({
              value: connector.slug,
              label: connector.name,
              description:
                connector.needs_connection && !usable(connector.id)
                  ? t('agents.connectorNotConnected')
                  : t('connections.tools', {
                      count: connector.tool_count,
                      readOnly: connector.read_only_tool_count,
                    }),
            }))}
            onChange={setDraft}
            onClose={() => {
              if (draft && !same(draft, agent.connectors ?? [])) save(draft);
              else setDraft(null);
            }}
          />
        </div>
      )}
    </>
  );
}
