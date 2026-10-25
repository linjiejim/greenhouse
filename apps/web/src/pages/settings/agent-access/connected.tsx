/**
 * Connected agents — the OAuth grants this member gave external agent/MCP
 * clients. Revoking one also ends its standing write grants (server side).
 */

import React, { useMemo } from 'react';
import { CrudPage, defineCrud, type CrudDataSource } from '../crud';
import { Button, Tag, TagList } from '../../../components/ui';
import { Key, Plug, Shield } from '../../../lib/icons';
import { fetchOAuthGrants, revokeOAuthGrant, type OAuthGrant } from '../../../lib/api/oauth';
import { formatDate } from '../../../lib/utils';
import { useT } from '../../../lib/i18n';
import { ClientAgentAvatar, connectionAvatar } from '../../../components/agents/client-agent-avatar';

const grantsDataSource: CrudDataSource<OAuthGrant> = {
  async list(params) {
    const grants = await fetchOAuthGrants();
    const skip = params.skip ?? 0;
    return { items: grants.slice(skip, skip + (params.limit ?? 50)), total: grants.length };
  },
  remove: revokeOAuthGrant,
};

export function ConnectedAgents({ onConnect }: { onConnect: () => void }) {
  const t = useT();
  const schema = useMemo(
    () =>
      defineCrud<OAuthGrant>({
        name: t('oauthGrants.connection'),
        icon: Key,
        testId: 'settings-oauth-grants',
        dataSource: grantsDataSource,
        pageSize: 50,
        storageKey: 'settings-oauth-grants',
        onRowClick: 'none',
        columns: [
          {
            key: 'client',
            label: t('oauthGrants.client'),
            type: 'custom',
            render: (grant) => (
              <div className="flex min-w-0 items-center gap-2">
                <ClientAgentAvatar name={grant.client.name} avatar={connectionAvatar(grant.client)} size="sm" />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-fg truncate" title={grant.client.name}>
                    {grant.client.name}
                  </div>
                  <div className="text-[10px] font-mono text-fg-faint truncate" title={grant.client.id}>
                    {grant.client.id}
                  </div>
                </div>
              </div>
            ),
          },
          {
            key: 'scopes',
            label: t('oauthGrants.access'),
            type: 'custom',
            render: (grant) => <TagList items={grant.scopes} max={2} />,
          },
          {
            key: 'status',
            label: t('common.status'),
            type: 'custom',
            width: '6rem',
            render: (grant) => (
              <Tag tone={grant.status === 'active' && grant.client.status === 'active' ? 'success' : 'neutral'}>
                {grant.client.status === 'disabled' ? t('oauthGrants.clientDisabled') : grant.status}
              </Tag>
            ),
          },
          {
            key: 'updated_at',
            label: t('common.updated'),
            type: 'custom',
            width: '9rem',
            render: (grant) => <span className="text-xs text-fg-muted">{formatDate(grant.updated_at)}</span>,
          },
        ],
        access: {
          canView: false,
          canAdd: false,
          canEdit: false,
          canDelete: true,
          canDeleteRow: (grant) => grant.status === 'active',
        },
        deleteConfirm: (grant) => ({
          title: t('oauthGrants.revokeTitle', { name: grant.client.name }),
          description: t('oauthGrants.revokeDescription'),
        }),
        slots: {
          banner: () => (
            <div className="mb-3 rounded-md border border-edge bg-info-subtle p-3 flex items-start gap-2">
              <Shield size={15} className="text-info flex-shrink-0 mt-0.5" />
              <p className="text-xs text-fg-secondary">{t('oauthGrants.banner')}</p>
            </div>
          ),
          empty: (
            <div className="text-center py-12">
              <Key size={22} className="mx-auto text-fg-faint mb-2" />
              <p className="text-sm text-fg-muted">{t('oauthGrants.empty')}</p>
              <Button size="sm" variant="secondary" className="mt-3" onClick={onConnect}>
                <Plug size={13} />
                {t('agentAccess.connectFirst')}
              </Button>
            </div>
          ),
        },
      }),
    [t, onConnect],
  );

  return <CrudPage schema={schema} />;
}
