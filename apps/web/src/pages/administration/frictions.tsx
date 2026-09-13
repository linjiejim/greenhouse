/**
 * Frictions panel — the review queue of things that got in the agent's way.
 *
 * Rows come from two writers: the nightly miner that harvests tool errors out of
 * message pipelines, and the `log_friction` tool for detours that never errored.
 * Identical stumbles collapse onto one row, so `occurrence_count` is the
 * priority order — the top of this list is what to fix next.
 *
 * Nothing here is fed back to the agent. The fix belongs in the harness: a
 * clearer tool description, a better error message, a prompt, a skill, or code.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { defineCrud, CrudPage, type CrudDataSource } from '../settings/crud';
import { Badge, Button, Select, Tag, toast } from '../../components/ui';
import { authFetch } from '../../lib/auth';
import { formatDate } from '../../lib/utils';
import { RefreshCw } from '../../lib/icons';
import { useT, type TranslationKey } from '../../lib/i18n';
import { ModulePage } from '../../components/app/module-page';

type FrictionStatus = 'new' | 'acknowledged' | 'resolved' | 'archived';
type FrictionKind = 'tool_error' | 'wrong_params' | 'detour' | 'data_quirk' | 'capability_gap';

interface Friction {
  id: number;
  fingerprint: string;
  tool_id: string | null;
  kind: FrictionKind;
  summary: string;
  detail: string | null;
  occurrence_count: number;
  sample_sessions: string;
  status: FrictionStatus;
  resolution_note: string | null;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

const KIND_LABEL: Record<FrictionKind, TranslationKey> = {
  tool_error: 'frictions.kind.toolError',
  wrong_params: 'frictions.kind.wrongParams',
  detour: 'frictions.kind.detour',
  data_quirk: 'frictions.kind.dataQuirk',
  capability_gap: 'frictions.kind.capabilityGap',
};

const STATUS_TONE: Record<FrictionStatus, 'danger' | 'warning' | 'success' | 'neutral'> = {
  new: 'danger',
  acknowledged: 'warning',
  resolved: 'success',
  archived: 'neutral',
};

export function FrictionsPanel() {
  const t = useT();
  const [statusFilter, setStatusFilter] = useState<'open' | FrictionStatus>('open');
  const [mining, setMining] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const dataSource = useMemo<CrudDataSource<Friction>>(
    () => ({
      async list() {
        void reloadKey;
        // 'open' is the working view: everything not yet dealt with.
        const params = new URLSearchParams({ limit: '200' });
        if (statusFilter !== 'open') params.set('status', statusFilter);

        const res = await authFetch(`/api/admin/frictions?${params}`);
        if (!res.ok) throw new Error(t('frictions.loadFailed'));
        const data = (await res.json()) as { total: number; frictions: Friction[] };

        const items =
          statusFilter === 'open'
            ? data.frictions.filter((f) => f.status === 'new' || f.status === 'acknowledged')
            : data.frictions;
        return { items, total: items.length };
      },
      async update(id, patch) {
        const res = await authFetch(`/api/admin/frictions/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || t('frictions.updateFailed'));
        }
        return (await res.json()) as Friction;
      },
      async remove(id) {
        const res = await authFetch(`/api/admin/frictions/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(t('frictions.deleteFailed'));
      },
    }),
    [statusFilter, reloadKey, t],
  );

  const runMiner = useCallback(async () => {
    try {
      setMining(true);
      const res = await authFetch('/api/admin/frictions/mine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ window_hours: 24 * 7 }),
      });
      if (!res.ok) throw new Error(t('frictions.scanFailed'));
      const result = (await res.json()) as { scanned: number; fingerprints: number; occurrences: number };
      toast(t('frictions.scanComplete', result), 'success');
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof Error ? err.message : t('frictions.scanFailed'), 'error');
    } finally {
      setMining(false);
    }
  }, [t]);

  const schema = useMemo(
    () =>
      defineCrud<Friction>({
        name: t('frictions.singular'),
        idField: 'id',
        dataSource,
        pageSize: 50,
        storageKey: 'administration-frictions',
        formMode: 'dialog',
        testId: 'frictions',
        // Without this the row actions never render and the whole triage loop
        // below (status workflow, resolution note, delete) is unreachable —
        // every permission defaults to false. Frictions are only ever created
        // by the miner or the log_friction tool, so no canAdd.
        access: { canEdit: true, canDelete: true },
        columns: [
          {
            key: 'summary',
            label: t('frictions.summary'),
            type: 'custom',
            render: (f) => (
              <div className="min-w-0">
                <div className="text-fg" title={f.summary}>
                  {f.summary}
                </div>
                {f.detail && <div className="text-xs text-fg-faint line-clamp-1 mt-0.5">{f.detail}</div>}
              </div>
            ),
          },
          {
            key: 'tool_id',
            label: t('frictions.tool'),
            width: '9rem',
            type: 'custom',
            render: (f) => (f.tool_id ? <Badge variant="secondary">{f.tool_id}</Badge> : <span>—</span>),
          },
          {
            key: 'kind',
            label: t('frictions.kindLabel'),
            width: '8rem',
            type: 'custom',
            render: (f) => <Tag tone="neutral">{t(KIND_LABEL[f.kind])}</Tag>,
          },
          {
            key: 'occurrence_count',
            label: t('frictions.hits'),
            width: '4rem',
            align: 'center',
            type: 'custom',
            render: (f) => <span className="tabular-nums font-medium">{f.occurrence_count}</span>,
          },
          {
            key: 'last_seen_at',
            label: t('frictions.lastSeen'),
            width: '10rem',
            type: 'custom',
            render: (f) => <span className="text-xs text-fg-secondary">{formatDate(f.last_seen_at)}</span>,
          },
          {
            key: 'status',
            label: t('common.status'),
            width: '7rem',
            type: 'custom',
            render: (f) => (
              <Tag tone={STATUS_TONE[f.status]}>{t(`frictions.status.${f.status}` as TranslationKey)}</Tag>
            ),
          },
        ],
        formFields: [
          {
            key: 'status',
            label: t('common.status'),
            type: 'select',
            options: [
              { value: 'new', label: t('frictions.status.new') },
              { value: 'acknowledged', label: t('frictions.statusAcknowledgedHint') },
              { value: 'resolved', label: t('frictions.statusResolvedHint') },
              { value: 'archived', label: t('frictions.statusArchivedHint') },
            ],
          },
          {
            key: 'resolution_note',
            label: t('frictions.resolutionNote'),
            type: 'textarea',
            placeholder: t('frictions.resolutionPlaceholder'),
          },
        ],
        deleteConfirm: (f) => ({
          title: t('frictions.deleteTitle'),
          message: t('frictions.deleteDescription', { summary: f.summary }),
        }),
        slots: {
          toolbar: () => (
            <div className="flex items-center gap-2">
              <Select
                size="sm"
                inline
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as 'open' | FrictionStatus)}
                aria-label={t('frictions.statusFilter')}
              >
                <option value="open">{t('frictions.open')}</option>
                <option value="new">{t('frictions.status.new')}</option>
                <option value="acknowledged">{t('frictions.status.acknowledged')}</option>
                <option value="resolved">{t('frictions.status.resolved')}</option>
                <option value="archived">{t('frictions.status.archived')}</option>
              </Select>
              <Button size="sm" variant="ghost" onClick={runMiner} disabled={mining}>
                <RefreshCw size={13} className={mining ? 'animate-spin' : ''} />
                {t(mining ? 'frictions.scanning' : 'frictions.scanLast7Days')}
              </Button>
            </div>
          ),
        },
      }),
    [dataSource, statusFilter, mining, runMiner, t],
  );

  return (
    <ModulePage
      moduleId="admin.frictions"
      layout="list"
      notice={
        <div className="bg-surface-raised border border-edge rounded-xl p-4">
          <p className="text-sm text-fg-muted">{t('frictions.description')}</p>
        </div>
      }
    >
      <CrudPage schema={schema} />
    </ModulePage>
  );
}
