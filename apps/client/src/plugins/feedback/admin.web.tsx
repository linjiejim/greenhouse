/**
 * Feedback plugin › Issues & requests (an Admin section, manifest page `issues`): feature requests
 * members and their agents file (/api/admin/feature-requests: status, priority, admin note) and
 * frictions — where the tooling got in the way (/api/admin/frictions: triage, resolution note,
 * delete, scan the last 7 days). `?view=frictions` opens the second tab (classic links).
 */
import React, { useCallback, useState } from 'react';
import { useRouter } from 'expo-router';
import { del, get, patch, post, seg } from '../../api/client';
import { useResource } from '../../data/use-resource';
import { usePrefs } from '../../store/prefs';
import { useT, localeOf } from '../../lib/i18n';
import { Icon } from '../../ui/core';
import { confirmAction } from '../../ui/dialogs';
import { toast } from '../../ui/toast';
import { AdminDialog, AdminPage, Badge, Field, SectionState, Tabs, type Tone } from '../../admin/kit.web';
import { useWrite } from '../../admin/use-write';
import { dateTimeLabel } from '../../admin/format';
import type { AdminScreenEntry, AdminScreenProps } from '../admin-types';

interface FeatureRequest {
  id: string;
  title: string;
  description: string;
  submitted_by_nickname?: string;
  submitted_by_role?: string;
  status: 'pending' | 'accepted' | 'rejected' | 'done';
  priority: 'low' | 'normal' | 'high';
  admin_note: string | null;
  session_id: string | null;
  created_at: string;
}
type FrictionStatus = 'new' | 'acknowledged' | 'resolved' | 'archived';
interface Friction {
  id: string;
  tool_id: string | null;
  kind: 'tool_error' | 'wrong_params' | 'detour' | 'data_quirk' | 'capability_gap';
  summary: string;
  detail: string | null;
  occurrence_count: number;
  status: FrictionStatus;
  resolution_note: string | null;
  last_seen_at: string;
}

const REQUEST_TONE: Record<FeatureRequest['status'], Tone> = {
  pending: 'warning',
  accepted: 'info',
  rejected: 'danger',
  done: 'success',
};
const FRICTION_TONE: Record<FrictionStatus, Tone> = {
  new: 'danger',
  acknowledged: 'warning',
  resolved: 'success',
  archived: 'neutral',
};

function IssuesScreen({ title, view }: AdminScreenProps) {
  const t = useT();
  const [tab, setTab] = useState<'requests' | 'frictions'>(view === 'frictions' ? 'frictions' : 'requests');
  return (
    <AdminPage
      title={title}
      testID="admin-issues"
      tabs={
        <Tabs
          label={title}
          value={tab}
          onChange={setTab}
          items={[
            { value: 'requests', label: t('admin.ext.feedback.requests') },
            { value: 'frictions', label: t('admin.ext.feedback.frictions') },
          ]}
        />
      }
    >
      {tab === 'requests' ? <Requests /> : <Frictions />}
    </AdminPage>
  );
}

function Requests() {
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const [status, setStatus] = useState('');
  const list = useResource(
    useCallback(
      () =>
        get<{ total: number; requests: FeatureRequest[] }>('/api/admin/feature-requests', {
          status: status || undefined,
        }),
      [status],
    ),
  );
  const [open, setOpen] = useState<FeatureRequest | null>(null);
  const { busy, run } = useWrite();
  const update = async (id: string, body: Partial<Pick<FeatureRequest, 'status' | 'priority' | 'admin_note'>>) => {
    const done = await run(
      () => patch(`/api/admin/feature-requests/${seg(id)}`, body),
      t('admin.ext.feedback.updateFailed'),
    );
    if (done) void list.refresh();
    return !!done;
  };
  const statusLabel = (s: FeatureRequest['status']) => t(`admin.ext.feedback.requestStatus.${s}`);
  const rows = list.data?.requests;
  return (
    <>
      <div className="gh-admin-toolbar" style={{ padding: 0, marginBottom: 12 }}>
        <select aria-label={t('admin.metering.status')} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('admin.ext.feedback.allStatuses')}</option>
          {(['pending', 'accepted', 'rejected', 'done'] as const).map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </select>
        <button
          className="gh-icon-button"
          aria-label={t('common.refresh')}
          disabled={list.loading}
          onClick={() => void list.refresh()}
        >
          <Icon name="refresh" size={16} />
        </button>
        {list.data ? (
          <span className="gh-admin-count">{t('admin.ext.feedback.total', { n: list.data.total })}</span>
        ) : null}
      </div>
      {rows?.length ? (
        <table className="gh-data-grid gh-admin-grid" data-testid="admin-requests">
          <thead>
            <tr>
              <th>{t('admin.ext.feedback.title')}</th>
              <th>{t('admin.metering.status')}</th>
              <th>{t('admin.ext.feedback.priority')}</th>
              <th>{t('admin.ext.feedback.by')}</th>
              <th>{t('admin.ext.feedback.when')}</th>
              <th aria-label={t('admin.actions')} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} data-open="" aria-label={r.title} onClick={() => setOpen(r)}>
                <td style={{ maxWidth: 480, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.title}>
                  {r.title}
                </td>
                <td>
                  <Badge tone={REQUEST_TONE[r.status]}>{statusLabel(r.status)}</Badge>
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <select
                    className="gh-admin-input"
                    style={{ height: 26 }}
                    aria-label={t('admin.ext.feedback.priority')}
                    value={r.priority}
                    disabled={busy}
                    onChange={(e) => void update(r.id, { priority: e.target.value as FeatureRequest['priority'] })}
                  >
                    {(['low', 'normal', 'high'] as const).map((p) => (
                      <option key={p} value={p}>
                        {t(`admin.ext.feedback.priorities.${p}`)}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  {r.submitted_by_nickname ?? '—'}
                  {r.submitted_by_role ? <span className="gh-admin-sub">{r.submitted_by_role}</span> : null}
                </td>
                <td>{dateTimeLabel(r.created_at, localeOf(lang))}</td>
                <td className="gh-admin-actions" onClick={(e) => e.stopPropagation()}>
                  {r.status === 'pending' ? (
                    <>
                      <button
                        className="gh-admin-link"
                        disabled={busy}
                        onClick={() => void update(r.id, { status: 'accepted' })}
                      >
                        {t('admin.ext.feedback.accept')}
                      </button>
                      <button
                        className="gh-admin-link"
                        disabled={busy}
                        onClick={() => void update(r.id, { status: 'rejected' })}
                      >
                        {t('admin.ext.feedback.reject')}
                      </button>
                    </>
                  ) : r.status === 'accepted' ? (
                    <button
                      className="gh-admin-link"
                      disabled={busy}
                      onClick={() => void update(r.id, { status: 'done' })}
                    >
                      {t('admin.ext.feedback.markDone')}
                    </button>
                  ) : (
                    <button
                      className="gh-admin-link"
                      disabled={busy}
                      onClick={() => void update(r.id, { status: 'pending' })}
                    >
                      {t('admin.ext.feedback.reopen')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <SectionState
          loading={list.loading && !list.data}
          error={list.error}
          retry={() => void list.refresh()}
          icon="form"
          title={t('admin.ext.feedback.noRequests')}
          message={t('admin.ext.feedback.noRequestsHint')}
        />
      )}
      {open ? <RequestDialog request={open} close={() => setOpen(null)} save={update} /> : null}
    </>
  );
}

function RequestDialog({
  request,
  close,
  save,
}: {
  request: FeatureRequest;
  close: () => void;
  save: (id: string, body: { admin_note: string }) => Promise<boolean>;
}) {
  const t = useT();
  const router = useRouter();
  const [note, setNote] = useState(request.admin_note ?? '');
  return (
    <AdminDialog
      title={request.title}
      onClose={close}
      testID="admin-request"
      footer={
        <>
          <button type="button" className="gh-secondary-button" onClick={close}>
            {t('common.close')}
          </button>
          <button
            type="button"
            className="gh-primary"
            disabled={note === (request.admin_note ?? '')}
            onClick={async () => {
              if (await save(request.id, { admin_note: note })) close();
            }}
          >
            {t('admin.ext.feedback.saveNote')}
          </button>
        </>
      }
    >
      <div className="gh-admin-form">
        <p style={{ margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{request.description}</p>
        {request.session_id ? (
          <button
            type="button"
            className="gh-admin-link"
            style={{ alignSelf: 'flex-start', padding: 0 }}
            onClick={() => {
              close();
              router.push({ pathname: '/chat', params: { session: request.session_id! } });
            }}
          >
            {t('admin.ext.feedback.viewConversation')}
          </button>
        ) : null}
        <Field label={t('admin.ext.feedback.note')}>
          {(id) => (
            <textarea
              id={id}
              rows={4}
              value={note}
              placeholder={t('admin.ext.feedback.notePlaceholder')}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
        </Field>
      </div>
    </AdminDialog>
  );
}

function Frictions() {
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const [status, setStatus] = useState<'open' | FrictionStatus>('open');
  const list = useResource(
    useCallback(
      () =>
        get<{ total: number; frictions: Friction[] }>('/api/admin/frictions', {
          limit: 200,
          status: status === 'open' ? undefined : status,
        }),
      [status],
    ),
  );
  const [editing, setEditing] = useState<Friction | null>(null);
  const { busy, run } = useWrite();
  const rows = (list.data?.frictions ?? []).filter(
    (f) => status !== 'open' || f.status === 'new' || f.status === 'acknowledged',
  );
  const scan = async () => {
    const result = await run(
      () => post<{ scanned: number; fingerprints: number }>('/api/admin/frictions/mine', { window_hours: 24 * 7 }),
      t('admin.ext.feedback.scanFailed'),
    );
    if (!result) return;
    toast(t('admin.ext.feedback.scanned', { scanned: result.scanned, found: result.fingerprints }));
    void list.refresh();
  };
  const statusLabel = (s: FrictionStatus) => t(`admin.ext.feedback.frictionStatus.${s}`);
  return (
    <>
      <p className="gh-admin-hint">{t('admin.ext.feedback.frictionsHint')}</p>
      <div className="gh-admin-toolbar" style={{ padding: 0, marginBottom: 12 }}>
        <select
          aria-label={t('admin.metering.status')}
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
        >
          <option value="open">{t('admin.ext.feedback.open')}</option>
          {(['new', 'acknowledged', 'resolved', 'archived'] as const).map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </select>
        <button className="gh-admin-button" disabled={busy} onClick={() => void scan()}>
          <Icon name="refresh" size={14} />
          {t('admin.ext.feedback.scan')}
        </button>
        {list.data ? <span className="gh-admin-count">{t('admin.ext.feedback.total', { n: rows.length })}</span> : null}
      </div>
      {rows.length ? (
        <table className="gh-data-grid gh-admin-grid" data-testid="admin-frictions">
          <thead>
            <tr>
              <th>{t('admin.ext.feedback.summary')}</th>
              <th>{t('admin.ext.feedback.tool')}</th>
              <th>{t('admin.ext.feedback.kind')}</th>
              <th className="gh-number">{t('admin.ext.feedback.hits')}</th>
              <th>{t('admin.ext.feedback.lastSeen')}</th>
              <th>{t('admin.metering.status')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.id} data-open="" aria-label={f.summary} onClick={() => setEditing(f)}>
                <td
                  style={{ maxWidth: 460, overflow: 'hidden', textOverflow: 'ellipsis' }}
                  title={f.detail ?? f.summary}
                >
                  {f.summary}
                </td>
                <td className="gh-admin-mono">{f.tool_id ?? '—'}</td>
                <td>
                  <Badge>{t(`admin.ext.feedback.frictionKind.${f.kind}`)}</Badge>
                </td>
                <td className="gh-number">{f.occurrence_count}</td>
                <td>{dateTimeLabel(f.last_seen_at, localeOf(lang))}</td>
                <td>
                  <Badge tone={FRICTION_TONE[f.status]}>{statusLabel(f.status)}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <SectionState
          loading={list.loading && !list.data}
          error={list.error}
          retry={() => void list.refresh()}
          icon="alert"
          title={t('admin.ext.feedback.noFrictions')}
        />
      )}
      {editing ? (
        <FrictionDialog friction={editing} close={() => setEditing(null)} changed={() => void list.refresh()} />
      ) : null}
    </>
  );
}

function FrictionDialog({ friction, close, changed }: { friction: Friction; close: () => void; changed: () => void }) {
  const t = useT();
  const [status, setStatus] = useState<FrictionStatus>(friction.status);
  const [note, setNote] = useState(friction.resolution_note ?? '');
  const { busy, run } = useWrite();
  const save = async () => {
    if (
      await run(
        () => patch(`/api/admin/frictions/${seg(friction.id)}`, { status, resolution_note: note }),
        t('admin.ext.feedback.updateFailed'),
      )
    ) {
      changed();
      close();
    }
  };
  const remove = async () => {
    const ok = await confirmAction({
      title: t('admin.ext.feedback.deleteTitle'),
      message: t('admin.ext.feedback.deleteHint', { summary: friction.summary }),
      confirmLabel: t('admin.ext.feedback.delete'),
      destructive: true,
    });
    if (!ok) return;
    if (await run(() => del(`/api/admin/frictions/${seg(friction.id)}`), t('admin.ext.feedback.deleteFailed'))) {
      changed();
      close();
    }
  };
  return (
    <AdminDialog
      title={friction.summary}
      onClose={close}
      testID="admin-friction"
      footer={
        <>
          <button
            type="button"
            className="gh-admin-button"
            data-tone="danger"
            disabled={busy}
            onClick={() => void remove()}
          >
            {t('admin.ext.feedback.delete')}
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="gh-secondary-button" onClick={close}>
            {t('common.cancel')}
          </button>
          <button type="button" className="gh-primary" disabled={busy} onClick={() => void save()}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="gh-admin-form">
        {friction.detail ? <p className="gh-admin-code">{friction.detail}</p> : null}
        <Field label={t('admin.metering.status')}>
          {(id) => (
            <select id={id} value={status} onChange={(e) => setStatus(e.target.value as FrictionStatus)}>
              {(['new', 'acknowledged', 'resolved', 'archived'] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`admin.ext.feedback.frictionStatusHint.${s}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('admin.ext.feedback.resolution')}>
          {(id) => (
            <textarea
              id={id}
              rows={4}
              value={note}
              placeholder={t('admin.ext.feedback.resolutionPlaceholder')}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
        </Field>
      </div>
    </AdminDialog>
  );
}

export const adminScreen: AdminScreenEntry = { screen: 'feedback-issues', icon: 'form', component: IssuesScreen };
