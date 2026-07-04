/**
 * Feature Requests Panel — super users view, filter, and triage user-submitted
 * requests. Rebuilt on @greenhouse/crud: schema-driven list + status filter,
 * status-transition row actions, an edit dialog (priority / admin note), and an
 * expandable row for the full description. No add/delete (requests arrive via
 * chat). Data source adapts the existing admin client — no server change.
 */

import React, { useMemo } from 'react';
import { defineCrud, CrudPage, type CrudDataSource } from '@greenhouse/crud';
import { toast } from '../../components/ui';
import { ClipboardList, Check, X, Clock, CheckCircle } from '../../lib/icons';
import { fetchFeatureRequests, updateFeatureRequest } from '../../lib/api';
import type { FeatureRequest } from '../../lib/api';
import { relativeTime } from '../../lib/utils';
import { useT } from '../../lib/i18n';

const STATUS_TONE = { pending: 'warning', accepted: 'secondary', rejected: 'destructive', done: 'success' } as const;
const PRIORITY_TONE = { high: 'destructive', normal: 'default', low: 'secondary' } as const;

const dataSource: CrudDataSource<FeatureRequest> = {
  async list(params) {
    const statusF = params.filter?.find((f) => f.key === 'status');
    const status = statusF ? String(statusF.value[0]) : undefined;
    // Fetch the full set (title search + count + paging are client-side here);
    // the default server limit of 50 would undercount and hide rows past 50.
    const { requests } = await fetchFeatureRequests(status, 1000);
    let items = requests;
    const titleF = params.filter?.find((f) => f.key === 'title');
    if (titleF) {
      const q = String(titleF.value[0]).toLowerCase();
      items = items.filter((r) => r.title.toLowerCase().includes(q));
    }
    const total = items.length;
    const skip = params.skip ?? 0;
    return { items: items.slice(skip, skip + (params.limit ?? 50)), total };
  },
  async get(id) {
    const found = (await fetchFeatureRequests(undefined, 1000)).requests.find((r) => String(r.id) === id);
    if (!found) throw new Error('Not found');
    return found;
  },
  update: (id, data) =>
    updateFeatureRequest(Number(id), data as { status?: string; priority?: string; admin_note?: string }),
};

async function transition(id: number, status: string, reload: () => void) {
  try {
    await updateFeatureRequest(id, { status });
    reload();
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Failed to update', 'error');
  }
}

export function FeatureRequestsPanel() {
  const t = useT();

  const schema = useMemo(
    () =>
      defineCrud<FeatureRequest>({
        name: t('settings.featureRequests'),
        icon: ClipboardList,
        dataSource,
        pageSize: 50,
        emptyMessage: 'No feature requests',
        defaultSort: { key: 'created_at', order: 'desc' },
        columns: [
          { key: 'id', label: '#', type: 'number', width: '3rem' },
          { key: 'title', label: 'Title', sortable: true },
          {
            key: 'status',
            label: 'Status',
            type: 'badge',
            width: '7rem',
            badgeMap: { ...STATUS_TONE },
          },
          { key: 'priority', label: 'Priority', type: 'badge', width: '6rem', badgeMap: { ...PRIORITY_TONE } },
          {
            key: 'submitted_by',
            label: 'Submitted by',
            type: 'custom',
            responsiveHide: 'md',
            render: (r) => (
              <span className="text-xs">
                <span className="text-fg-secondary font-medium">{r.submitted_by_nickname}</span>
                <span className="text-fg-faint ml-1">({r.submitted_by_role})</span>
              </span>
            ),
          },
          {
            key: 'created_at',
            label: 'Time',
            type: 'custom',
            width: '7rem',
            responsiveHide: 'md',
            render: (r) => <span className="text-xs text-fg-faint">{relativeTime(r.created_at)}</span>,
          },
          // Detail-only columns (shown in the expanded row).
          { key: 'description', label: 'Description', hidden: true },
          { key: 'admin_note', label: 'Admin note', hidden: true },
        ],
        filters: [
          { key: 'title', label: 'Search title', kind: 'text' },
          {
            key: 'status',
            label: 'All Status',
            kind: 'select',
            options: [
              { value: 'pending', label: 'Pending' },
              { value: 'accepted', label: 'Accepted' },
              { value: 'rejected', label: 'Rejected' },
              { value: 'done', label: 'Done' },
            ],
          },
        ],
        formFields: [
          {
            key: 'status',
            label: 'Status',
            type: 'select',
            width: 2,
            options: [
              { value: 'pending', label: 'Pending' },
              { value: 'accepted', label: 'Accepted' },
              { value: 'rejected', label: 'Rejected' },
              { value: 'done', label: 'Done' },
            ],
          },
          {
            key: 'priority',
            label: 'Priority',
            type: 'select',
            width: 2,
            options: [
              { value: 'low', label: 'Low' },
              { value: 'normal', label: 'Normal' },
              { value: 'high', label: 'High' },
            ],
          },
          { key: 'admin_note', label: 'Admin note', type: 'textarea', rows: 3 },
        ],
        formTitle: () => 'Update request',
        access: { canEdit: true },
        tableActions: [
          {
            key: 'accept',
            label: 'Accept',
            icon: Check,
            tone: 'success',
            visible: (r) => r.status === 'pending',
            onClick: (r, ctx) => transition(r.id, 'accepted', ctx.reload),
          },
          {
            key: 'reject',
            label: 'Reject',
            icon: X,
            tone: 'danger',
            visible: (r) => r.status === 'pending',
            onClick: (r, ctx) => transition(r.id, 'rejected', ctx.reload),
          },
          {
            key: 'done',
            label: 'Mark done',
            icon: CheckCircle,
            tone: 'success',
            visible: (r) => r.status === 'accepted',
            onClick: (r, ctx) => transition(r.id, 'done', ctx.reload),
          },
          {
            key: 'reopen',
            label: 'Reopen',
            icon: Clock,
            tone: 'warning',
            visible: (r) => r.status === 'rejected' || r.status === 'done',
            onClick: (r, ctx) => transition(r.id, 'pending', ctx.reload),
          },
        ],
        slots: {
          rowExpand: (r) => (
            <div className="space-y-2">
              <p className="text-sm text-fg-secondary whitespace-pre-wrap">{r.description}</p>
              {r.session_id && (
                <a href={`#/chat?session=${r.session_id}`} className="text-xs text-primary-fg hover:underline">
                  View session →
                </a>
              )}
              <div className="pt-2 border-t border-edge">
                <span className="text-[10px] text-fg-faint uppercase tracking-wider">Admin Note</span>
                <p className="text-sm text-fg-secondary mt-0.5">
                  {r.admin_note || <span className="text-fg-faint">No note yet</span>}
                </p>
              </div>
            </div>
          ),
        },
      }),
    [t],
  );

  return <CrudPage schema={schema} />;
}
