/**
 * Standing grants — pre-approvals for one kind of shared-data write by your
 * agents. Deletes can never be granted (the server refuses them too).
 */

import React, { useMemo } from 'react';
import {
  AGENT_WRITE_GRANT_DAY_OPTIONS,
  type AgentWriteGrantDayOption,
  type AgentWriteGrantWire,
} from '@greenhouse/types/agent-access';
import { CrudPage, defineCrud, type CrudDataSource } from '../crud';
import { Tag } from '../../../components/ui';
import { ShieldCheck } from '../../../lib/icons';
import { formatDate } from '../../../lib/utils';
import { useT } from '../../../lib/i18n';
import {
  createAgentWriteGrant,
  fetchAgentWriteGrants,
  fetchAgentWriteTools,
  revokeAgentWriteGrant,
} from '../../../lib/api/agent-access';
import { fetchOAuthGrants } from '../../../lib/api/oauth';

/** `days` only exists in the add form; listed rows carry `expires_at` instead. */
type GrantRow = AgentWriteGrantWire & { days?: string };

function grantState(grant: GrantRow): 'live' | 'revoked' | 'expired' {
  if (grant.revoked_at) return 'revoked';
  return Date.parse(grant.expires_at) > Date.now() ? 'live' : 'expired';
}

const dataSource: CrudDataSource<GrantRow> = {
  async list(params) {
    const grants = await fetchAgentWriteGrants();
    const skip = params.skip ?? 0;
    return { items: grants.slice(skip, skip + (params.limit ?? 50)), total: grants.length };
  },
  async create(data) {
    const action = typeof data.action === 'string' && data.action.trim() ? data.action.trim() : null;
    const clientId = typeof data.client_id === 'string' && data.client_id ? data.client_id : null;
    await createAgentWriteGrant({
      tool_id: String(data.tool_id ?? ''),
      action,
      client_id: clientId,
      days: Number(data.days ?? 7) as AgentWriteGrantDayOption,
    });
  },
  remove: revokeAgentWriteGrant,
};

export function StandingGrants() {
  const t = useT();
  const schema = useMemo(
    () =>
      defineCrud<GrantRow>({
        name: t('agentAccess.grantName'),
        icon: ShieldCheck,
        testId: 'agent-access-grants',
        dataSource,
        pageSize: 50,
        storageKey: 'agent-access-grants',
        onRowClick: 'none',
        columns: [
          {
            key: 'tool_name',
            label: t('agentAccess.grantTool'),
            type: 'custom',
            render: (grant) => (
              <div className="min-w-0">
                <div className="text-sm text-fg truncate">{grant.tool_name}</div>
                <div className="text-[10px] font-mono text-fg-faint truncate">{grant.tool_id}</div>
              </div>
            ),
          },
          {
            key: 'action',
            label: t('agentAccess.grantAction'),
            type: 'custom',
            render: (grant) =>
              grant.action ? (
                <span className="font-mono text-xs text-fg-secondary">{grant.action}</span>
              ) : (
                <span className="text-xs text-fg-muted">{t('agentAccess.grantActionAll')}</span>
              ),
          },
          {
            key: 'client_name',
            label: t('agentAccess.grantAgent'),
            type: 'custom',
            render: (grant) => (
              <span className="text-xs text-fg-secondary">{grant.client_name ?? t('agentAccess.grantAgentAll')}</span>
            ),
          },
          {
            key: 'expires_at',
            label: t('agentAccess.grantExpires'),
            type: 'custom',
            width: '9rem',
            render: (grant) => <span className="text-xs text-fg-muted">{formatDate(grant.expires_at)}</span>,
          },
          {
            key: 'use_count',
            label: t('agentAccess.grantUses'),
            type: 'custom',
            width: '5rem',
            render: (grant) => <span className="text-xs text-fg-muted tabular-nums">{grant.use_count}</span>,
          },
          {
            key: 'created_via',
            label: t('agentAccess.grantSource'),
            type: 'custom',
            width: '7rem',
            render: (grant) => (
              <span className="text-xs text-fg-muted">
                {grant.created_via === 'approval'
                  ? t('agentAccess.grantSourceApproval')
                  : t('agentAccess.grantSourceSettings')}
              </span>
            ),
          },
          {
            key: 'revoked_at',
            label: t('common.status'),
            type: 'custom',
            width: '6rem',
            render: (grant) => {
              const state = grantState(grant);
              return (
                <Tag tone={state === 'live' ? 'success' : 'neutral'}>
                  {state === 'live'
                    ? t('agentAccess.grantStatusLive')
                    : state === 'revoked'
                      ? t('agentAccess.grantStatusRevoked')
                      : t('agentAccess.grantStatusExpired')}
                </Tag>
              );
            },
          },
        ],
        formFields: [
          {
            key: 'tool_id',
            label: t('agentAccess.grantTool'),
            type: 'select',
            required: true,
            options: async () =>
              (await fetchAgentWriteTools()).map((tool) => ({ value: tool.id, label: `${tool.name} (${tool.id})` })),
          },
          {
            key: 'action',
            label: t('agentAccess.grantAction'),
            type: 'text',
            placeholder: t('agentAccess.grantActionAll'),
            help: t('agentAccess.grantActionHelp'),
            maxLength: 200,
          },
          {
            key: 'client_id',
            label: t('agentAccess.grantAgent'),
            type: 'select',
            width: 2,
            defaultValue: '',
            options: async () => [
              { value: '', label: t('agentAccess.grantAgentAll') },
              ...(await fetchOAuthGrants())
                .filter((grant) => grant.status === 'active' && grant.client.status === 'active')
                .map((grant) => ({ value: grant.client.id, label: grant.client.name })),
            ],
          },
          {
            key: 'days',
            label: t('agentAccess.grantDays'),
            type: 'select',
            width: 2,
            required: true,
            defaultValue: '7',
            options: AGENT_WRITE_GRANT_DAY_OPTIONS.map((days) => ({
              value: String(days),
              label: days === 1 ? t('agentAccess.allowDay') : t('agentAccess.allowDays', { days }),
            })),
          },
        ],
        access: {
          canView: false,
          canAdd: true,
          canEdit: false,
          canDelete: true,
          canDeleteRow: (grant) => grantState(grant as unknown as GrantRow) === 'live',
        },
        deleteConfirm: () => ({
          title: t('agentAccess.revokeGrantTitle'),
          description: t('agentAccess.revokeGrantDescription'),
        }),
        slots: {
          banner: () => (
            <div className="mb-3 rounded-lg border border-edge bg-info-subtle p-3 flex items-start gap-2">
              <ShieldCheck size={15} className="text-info flex-shrink-0 mt-0.5" />
              <p className="text-xs text-fg-secondary">{t('agentAccess.grantsIntro')}</p>
            </div>
          ),
          empty: (
            <div className="text-center py-12">
              <ShieldCheck size={22} className="mx-auto text-fg-faint mb-2" />
              <p className="text-sm text-fg-muted">{t('agentAccess.grantsEmpty')}</p>
            </div>
          ),
        },
      }),
    [t],
  );
  return <CrudPage schema={schema} />;
}
