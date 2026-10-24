/**
 * Activity — every write your agents made over MCP, newest first: what ran,
 * on what basis, and the exact input / output (the Runtime run is the record).
 */

import React, { useMemo } from 'react';
import type { AgentWriteView } from '@greenhouse/types/agent-access';
import { CrudPage, defineCrud, type CrudDataSource } from '../crud';
import { History } from '../../../lib/icons';
import { formatDate } from '../../../lib/utils';
import { useT } from '../../../lib/i18n';
import { fetchRecentAgentWrites } from '../../../lib/api/agent-access';
import { BasisLabel, InputFields, JsonBlock, OperationLabel, RiskTag, StatusTag, writeTarget } from './shared';
import { ClientAgentAvatar, connectionAvatar } from '../../../components/agents/client-agent-avatar';

type ActivityRow = AgentWriteView & { id: string };

const dataSource: CrudDataSource<ActivityRow> = {
  async list(params) {
    const rows = (await fetchRecentAgentWrites()).map((row) => ({ ...row, id: row.request_id }));
    const skip = params.skip ?? 0;
    return { items: rows.slice(skip, skip + (params.limit ?? 25)), total: rows.length };
  },
};

export function AgentActivity() {
  const t = useT();
  const schema = useMemo(
    () =>
      defineCrud<ActivityRow>({
        name: t('agentAccess.tabActivity'),
        icon: History,
        testId: 'agent-access-activity',
        dataSource,
        pageSize: 25,
        storageKey: 'agent-access-activity',
        onRowClick: 'none',
        columns: [
          {
            key: 'created_at',
            label: t('agentAccess.colTime'),
            type: 'custom',
            width: '9rem',
            render: (row) => <span className="text-xs text-fg-muted">{formatDate(row.created_at)}</span>,
          },
          {
            key: 'client_name',
            label: t('agentAccess.colAgent'),
            type: 'custom',
            width: '9rem',
            render: (row) => (
              <span className="flex min-w-0 items-center gap-1.5">
                <ClientAgentAvatar name={row.client_name} avatar={connectionAvatar(row)} />
                <span className="text-sm text-fg truncate">{row.client_name}</span>
              </span>
            ),
          },
          {
            key: 'tool_id',
            label: t('agentAccess.colOperation'),
            type: 'custom',
            render: (row) => {
              const target = row.target_label ?? writeTarget(row.input);
              return (
                <div className="min-w-0">
                  <OperationLabel view={row} />
                  {target && <div className="text-xs text-fg truncate">{target}</div>}
                </div>
              );
            },
          },
          {
            key: 'risk',
            label: t('agentAccess.colRisk'),
            type: 'custom',
            width: '7rem',
            render: (row) => <RiskTag risk={row.risk} />,
          },
          {
            key: 'status',
            label: t('agentAccess.colResult'),
            type: 'custom',
            width: '7rem',
            render: (row) => <StatusTag status={row.status} />,
          },
          {
            key: 'basis',
            label: t('agentAccess.colBasis'),
            type: 'custom',
            width: '8rem',
            render: (row) => <BasisLabel basis={row.basis} />,
          },
        ],
        access: { canView: false, canAdd: false, canEdit: false, canDelete: false },
        slots: {
          rowExpand: (row) => (
            <div className="grid gap-3 md:grid-cols-2 py-1">
              <div>
                <div className="text-[11px] font-medium text-fg-muted mb-1">{t('agentAccess.input')}</div>
                <InputFields value={row.input} />
              </div>
              <div>
                <div className="text-[11px] font-medium text-fg-muted mb-1">
                  {row.error ? t('agentAccess.error') : t('agentAccess.output')}
                </div>
                <JsonBlock value={row.error ?? row.output} />
              </div>
            </div>
          ),
          empty: (
            <div className="text-center py-12">
              <History size={22} className="mx-auto text-fg-faint mb-2" />
              <p className="text-sm text-fg-muted">{t('agentAccess.activityEmpty')}</p>
            </div>
          ),
        },
      }),
    [t],
  );
  return <CrudPage schema={schema} />;
}
