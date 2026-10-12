/**
 * Administration → Public Agents (super only; spec 20261011-agent-first-class P4, D40).
 *
 * Every Agent a member published: its owner, published version, audience, how many people talk to it
 * and whether it is available. An administrator can pause one (nobody but its owner can use it until
 * resumed) and resume it — and nothing else: no conversation, instructions or transfer of ownership
 * is reachable from here (`GET /api/admin/agents`, `POST /api/admin/agents/:id/pause|resume`).
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { ModulePage } from '../../components/app/module-page';
import { Button, ConfirmDialog, EmptyState, Tag, toast, type TagTone } from '../../components/ui';
import { Globe, Pause, Play, RefreshCw } from '../../lib/icons';
import { useT, type TranslationKey } from '../../lib/i18n';
import { fetchAdminPublicAgents, setAdminPublicAgentPaused, type AdminPublicAgentRow } from '../../lib/api/bots';
import { CrudPage, defineCrud, type CrudDataSource } from '../settings/crud';

/** Who it was published to, in the reader's language: everyone, or how many members and groups. */
export function audienceLabel(audience: AdminPublicAgentRow['audience'], t: ReturnType<typeof useT>): string {
  if (audience.everyone) return t('bots.publicAdmin.audienceEveryone');
  return t('bots.publicAdmin.audienceSome', { people: audience.user_count, groups: audience.group_count });
}

function stateOf(row: AdminPublicAgentRow): { key: TranslationKey; tone: TagTone } {
  if (row.paused) return { key: 'bots.publicAdmin.state_paused', tone: 'warning' };
  if (row.available) return { key: 'bots.publicAdmin.state_available', tone: 'success' };
  return { key: 'bots.publicAdmin.state_unpublished', tone: 'neutral' };
}

export function PublicAgentsPanel() {
  const t = useT();
  const reloadRef = useRef<(() => void) | null>(null);
  const reload = useCallback(() => reloadRef.current?.(), []);
  const [pauseTarget, setPauseTarget] = useState<AdminPublicAgentRow | null>(null);

  const dataSource = useMemo<CrudDataSource<AdminPublicAgentRow>>(
    () => ({
      async list(params) {
        const rows = await fetchAdminPublicAgents();
        const skip = params.skip ?? 0;
        return { items: rows.slice(skip, skip + (params.limit ?? 50)), total: rows.length };
      },
    }),
    [],
  );

  const setPaused = useCallback(
    async (row: AdminPublicAgentRow, paused: boolean) => {
      try {
        await setAdminPublicAgentPaused(row.id, paused);
        toast(t(paused ? 'bots.publicAdmin.paused' : 'bots.publicAdmin.resumed', { name: row.name }), 'success');
        reload();
      } catch (err) {
        toast(err instanceof Error && err.message ? err.message : t('bots.publicAdmin.actionFailed'), 'error');
      }
    },
    [reload, t],
  );

  const schema = useMemo(
    () =>
      defineCrud<AdminPublicAgentRow>({
        name: t('bots.publicAdmin.entity'),
        testId: 'public-agents',
        dataSource,
        idField: 'id',
        icon: Globe,
        columns: [
          {
            key: 'name',
            label: t('bots.publicAdmin.col_agent'),
            type: 'custom',
            render: (row) => (
              <span className="block max-w-[220px] truncate text-sm font-medium text-fg" title={row.name}>
                {row.name}
              </span>
            ),
          },
          {
            key: 'owner',
            label: t('bots.publicAdmin.col_owner'),
            type: 'custom',
            render: (row) => (
              <span className="block max-w-[180px] truncate text-sm text-fg-secondary" title={row.owner.nickname}>
                {row.owner.nickname}
              </span>
            ),
          },
          {
            key: 'published_version',
            label: t('bots.publicAdmin.col_version'),
            type: 'custom',
            render: (row) => (
              <span className="text-xs text-fg-muted">
                {row.published_version === null ? '—' : `v${row.published_version}`}
              </span>
            ),
          },
          {
            key: 'audience',
            label: t('bots.publicAdmin.col_audience'),
            type: 'custom',
            responsiveHide: 'md',
            render: (row) => (
              <span className="whitespace-nowrap text-xs text-fg-secondary">{audienceLabel(row.audience, t)}</span>
            ),
          },
          {
            key: 'users',
            label: t('bots.publicAdmin.col_users'),
            type: 'custom',
            align: 'right',
            render: (row) => <span className="font-mono text-xs text-fg-muted">{row.users}</span>,
          },
          {
            key: 'state',
            label: t('bots.publicAdmin.col_state'),
            type: 'custom',
            render: (row) => {
              const state = stateOf(row);
              return <Tag tone={state.tone}>{t(state.key)}</Tag>;
            },
          },
        ],
        tableActions: [
          {
            key: 'pause',
            label: t('bots.publicAdmin.pause'),
            icon: Pause,
            tone: 'warning',
            visible: (row) => !row.paused,
            onClick: (row) => setPauseTarget(row),
          },
          {
            key: 'resume',
            label: t('bots.publicAdmin.resume'),
            icon: Play,
            visible: (row) => row.paused,
            onClick: (row) => void setPaused(row, false),
          },
        ],
        slots: {
          toolbar: (ctx) => {
            reloadRef.current = ctx.reload;
            return (
              <div className="flex items-center gap-2">
                <Globe size={14} className="text-primary-fg" aria-hidden="true" />
                <h2 className="text-sm font-semibold text-fg">{t('bots.publicAdmin.title')}</h2>
                <span className="text-xs text-fg-muted">{t('bots.publicAdmin.count', { count: ctx.total })}</span>
              </div>
            );
          },
          empty: (
            <EmptyState
              variant="compact"
              icon={Globe}
              title={t('bots.publicAdmin.emptyTitle')}
              description={t('bots.publicAdmin.emptyDescription')}
            />
          ),
        },
      }),
    [dataSource, setPaused, t],
  );

  return (
    <ModulePage
      moduleId="admin.public-agents"
      layout="list"
      actions={
        <Button size="sm" variant="outline" onClick={reload} data-testid="public-agents-refresh">
          <RefreshCw size={14} className="mr-1" aria-hidden="true" />
          {t('bots.publicAdmin.refresh')}
        </Button>
      }
    >
      <CrudPage schema={schema} />
      <ConfirmDialog
        open={pauseTarget !== null}
        onClose={() => setPauseTarget(null)}
        onConfirm={() => {
          const row = pauseTarget;
          setPauseTarget(null);
          if (row) void setPaused(row, true);
        }}
        title={t('bots.publicAdmin.pauseTitle', { name: pauseTarget?.name ?? '' })}
        description={t('bots.publicAdmin.pauseDescription')}
        confirmLabel={t('bots.publicAdmin.pause')}
      />
    </ModulePage>
  );
}
