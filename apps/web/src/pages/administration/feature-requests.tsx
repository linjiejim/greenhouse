/**
 * Feature Requests Panel — table-based layout.
 * super 用户查看、过滤、编辑用户提交的需求。
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Button, EmptyState, IconButton, Select, Spinner, Textarea } from '../../components/ui';
import { ClipboardList, Check, X, Clock, CheckCircle } from '../../lib/icons';
import { fetchFeatureRequests, updateFeatureRequest } from '../../lib/api';
import type { FeatureRequest } from '../../lib/api';
import { relativeTime } from '../../lib/utils';
import { useT, type TranslationKey } from '../../lib/i18n';
import { ModulePage } from '../../components/app/module-page';

// ─── Status Styles ───────────────────────────────────────

const STATUS_STYLES: Record<string, { bg: string; text: string; labelKey: TranslationKey }> = {
  pending: { bg: 'bg-warning-subtle', text: 'text-warning', labelKey: 'common.pending' },
  accepted: { bg: 'bg-info-subtle', text: 'text-info', labelKey: 'common.accepted' },
  rejected: { bg: 'bg-danger-subtle', text: 'text-danger', labelKey: 'common.rejected' },
  done: { bg: 'bg-success-subtle', text: 'text-success-fg', labelKey: 'common.done' },
};

const PRIORITY_STYLES: Record<string, { color: string; labelKey: TranslationKey }> = {
  high: { color: 'text-danger', labelKey: 'common.high' },
  normal: { color: 'text-fg-secondary', labelKey: 'common.normal' },
  low: { color: 'text-fg-faint', labelKey: 'common.low' },
};

// ─── Main Component ──────────────────────────────────────

export function FeatureRequestsPanel() {
  const t = useT();
  const [requests, setRequests] = useState<FeatureRequest[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [editingNote, setEditingNote] = useState<number | null>(null);
  const [noteText, setNoteText] = useState('');
  const [saving, setSaving] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchFeatureRequests(filter || undefined);
      setRequests(data.requests);
      setTotal(data.total);
    } catch (_err) {
      /* ignore */
    }
    setLoading(false);
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  const handleStatusChange = async (id: number, status: string) => {
    setSaving(id);
    try {
      await updateFeatureRequest(id, { status });
      await load();
    } catch (_err) {
      /* ignore */
    }
    setSaving(null);
  };

  const handlePriorityChange = async (id: number, priority: string) => {
    setSaving(id);
    try {
      await updateFeatureRequest(id, { priority });
      await load();
    } catch (_err) {
      /* ignore */
    }
    setSaving(null);
  };

  const handleSaveNote = async (id: number) => {
    setSaving(id);
    try {
      await updateFeatureRequest(id, { admin_note: noteText });
      setEditingNote(null);
      await load();
    } catch (_err) {
      /* ignore */
    }
    setSaving(null);
  };

  return (
    <ModulePage
      moduleId="admin.feature-requests"
      layout="list"
      toolbar={
        <div className="flex items-center gap-3">
          <Select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="text-xs w-auto"
            aria-label={t('common.status')}
          >
            <option value="">{t('settings.allStatus')}</option>
            <option value="pending">{t('common.pending')}</option>
            <option value="accepted">{t('common.accepted')}</option>
            <option value="rejected">{t('common.rejected')}</option>
            <option value="done">{t('common.done')}</option>
          </Select>
          <span className="text-xs text-fg-muted">{t('settings.requestTotal', { count: total })}</span>
          <div className="flex-1" />
          <IconButton label={t('common.refresh')} onClick={load}>
            <Clock size={14} />
          </IconButton>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Loading */}
        {loading && (
          <div className="flex justify-center py-8">
            <Spinner className="text-primary-fg" />
          </div>
        )}

        {/* Empty state */}
        {!loading && requests.length === 0 && (
          <EmptyState
            icon={ClipboardList}
            title={t('settings.noFeatureRequests')}
            description={filter ? t('settings.noRequestsForStatus', { status: filter }) : t('settings.noRequestsYet')}
          />
        )}

        {/* Table */}
        {!loading && requests.length > 0 && (
          <div className="bg-surface-raised border border-edge rounded-lg overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-surface-sunken text-fg-muted">
                <tr>
                  <th className="text-left px-3 py-2 w-10">#</th>
                  <th className="text-left px-3 py-2">{t('common.title')}</th>
                  <th className="text-left px-3 py-2 w-20">{t('common.status')}</th>
                  <th className="text-left px-3 py-2 w-20">{t('common.priority')}</th>
                  <th className="text-left px-3 py-2 w-32">{t('settings.submittedBy')}</th>
                  <th className="text-left px-3 py-2 w-24">{t('common.time')}</th>
                  <th className="text-center px-3 py-2 w-28">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge">
                {requests.map((r) => {
                  const statusStyle = STATUS_STYLES[r.status] || STATUS_STYLES.pending;
                  const priorityStyle = PRIORITY_STYLES[r.priority] || PRIORITY_STYLES.normal;
                  const isSaving = saving === r.id;
                  const isExpanded = expandedId === r.id;
                  const isEditing = editingNote === r.id;

                  return (
                    <React.Fragment key={r.id}>
                      <tr
                        className={`hover:bg-surface-sunken cursor-pointer transition-colors ${isExpanded ? 'bg-surface-sunken' : ''}`}
                        onClick={() => setExpandedId(isExpanded ? null : r.id)}
                      >
                        <td className="px-3 py-2 text-fg-faint text-xs font-mono">{r.id}</td>
                        <td className="px-3 py-2">
                          <div className="font-medium text-fg truncate max-w-md" title={r.title}>
                            {r.title}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${statusStyle.bg} ${statusStyle.text}`}
                          >
                            {t(statusStyle.labelKey)}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span className={`text-xs ${priorityStyle.color}`}>{t(priorityStyle.labelKey)}</span>
                        </td>
                        <td className="px-3 py-2">
                          <span className="text-xs text-fg-secondary font-medium">{r.submitted_by_nickname}</span>
                          <span className="text-[10px] text-fg-faint ml-1">({r.submitted_by_role})</span>
                        </td>
                        <td className="px-3 py-2 text-xs text-fg-faint">{relativeTime(r.created_at)}</td>
                        <td className="px-3 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-center gap-1">
                            {r.status === 'pending' && (
                              <>
                                <button
                                  onClick={() => handleStatusChange(r.id, 'accepted')}
                                  disabled={isSaving}
                                  className="p-1 text-fg-muted hover:text-success hover:bg-success-subtle rounded transition-colors"
                                  title={t('settings.accept')}
                                >
                                  <Check size={13} />
                                </button>
                                <button
                                  onClick={() => handleStatusChange(r.id, 'rejected')}
                                  disabled={isSaving}
                                  className="p-1 text-fg-muted hover:text-danger hover:bg-danger-subtle rounded transition-colors"
                                  title={t('settings.reject')}
                                >
                                  <X size={13} />
                                </button>
                              </>
                            )}
                            {r.status === 'accepted' && (
                              <button
                                onClick={() => handleStatusChange(r.id, 'done')}
                                disabled={isSaving}
                                className="p-1 text-fg-muted hover:text-success hover:bg-success-subtle rounded transition-colors"
                                title={t('settings.markDone')}
                              >
                                <CheckCircle size={13} />
                              </button>
                            )}
                            {(r.status === 'rejected' || r.status === 'done') && (
                              <button
                                onClick={() => handleStatusChange(r.id, 'pending')}
                                disabled={isSaving}
                                className="p-1 text-fg-muted hover:text-warning hover:bg-warning-subtle rounded transition-colors"
                                title={t('settings.reopen')}
                              >
                                <Clock size={13} />
                              </button>
                            )}
                            <Select
                              value={r.priority}
                              onChange={(e) => handlePriorityChange(r.id, e.target.value)}
                              className="text-[10px] py-0 px-1 w-16 h-6"
                              disabled={isSaving}
                            >
                              <option value="low">{t('common.low')}</option>
                              <option value="normal">{t('common.normal')}</option>
                              <option value="high">{t('common.high')}</option>
                            </Select>
                          </div>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={7} className="px-6 py-3 bg-surface-sunken">
                            <div className="space-y-3">
                              <p className="text-sm text-fg-secondary whitespace-pre-wrap">{r.description}</p>
                              {r.session_id && (
                                <a
                                  href={`#/chat?session=${r.session_id}`}
                                  className="text-xs text-primary-fg hover:text-primary-fg-strong hover:underline"
                                >
                                  {t('settings.viewSession')}
                                </a>
                              )}
                              {/* Admin note */}
                              <div className="pt-2 border-t border-edge">
                                {isEditing ? (
                                  <div className="space-y-2">
                                    <Textarea
                                      value={noteText}
                                      onChange={(e) => setNoteText(e.target.value)}
                                      rows={2}
                                      placeholder={t('settings.adminNotePlaceholder')}
                                    />
                                    <div className="flex gap-2 justify-end">
                                      <Button variant="ghost" size="sm" onClick={() => setEditingNote(null)}>
                                        {t('common.cancel')}
                                      </Button>
                                      <Button size="sm" onClick={() => handleSaveNote(r.id)} disabled={isSaving}>
                                        {isSaving ? t('common.saving') : t('common.save')}
                                      </Button>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="flex items-start justify-between">
                                    <div>
                                      <span className="text-[10px] text-fg-faint uppercase tracking-wider">
                                        {t('settings.adminNote')}
                                      </span>
                                      {r.admin_note ? (
                                        <p className="text-sm text-fg-secondary mt-0.5">{r.admin_note}</p>
                                      ) : (
                                        <p className="text-xs text-fg-faint mt-0.5">{t('settings.noNote')}</p>
                                      )}
                                    </div>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setEditingNote(r.id);
                                        setNoteText(r.admin_note || '');
                                      }}
                                      className="text-xs text-fg-faint hover:text-primary-fg"
                                    >
                                      {r.admin_note ? t('common.edit') : t('settings.addNote')}
                                    </button>
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </ModulePage>
  );
}
