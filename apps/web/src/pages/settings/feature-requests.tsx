/**
 * Feature Requests Panel — table-based layout.
 * super 用户查看、过滤、编辑用户提交的需求。
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Button, Spinner, Select, EmptyState, Textarea } from '../../components/ui';
import { ClipboardList, Check, X, Clock, CheckCircle } from '../../lib/icons';
import { fetchFeatureRequests, updateFeatureRequest } from '../../lib/api';
import type { FeatureRequest } from '../../lib/api';
import { relativeTime } from '../../lib/utils';
import { useT } from '../../lib/i18n';

// ─── Status Styles ───────────────────────────────────────

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  pending: { bg: 'bg-warning-subtle', text: 'text-warning', label: 'Pending' },
  accepted: { bg: 'bg-info-subtle', text: 'text-info', label: 'Accepted' },
  rejected: { bg: 'bg-danger-subtle', text: 'text-danger', label: 'Rejected' },
  done: { bg: 'bg-success-subtle', text: 'text-success-fg', label: 'Done' },
};

const PRIORITY_STYLES: Record<string, { color: string; label: string }> = {
  high: { color: 'text-danger', label: '🔴 High' },
  normal: { color: 'text-fg-secondary', label: 'Normal' },
  low: { color: 'text-fg-faint', label: 'Low' },
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
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <Select value={filter} onChange={(e) => setFilter(e.target.value)} className="text-xs w-auto">
          <option value="">All Status</option>
          <option value="pending">Pending</option>
          <option value="accepted">Accepted</option>
          <option value="rejected">Rejected</option>
          <option value="done">Done</option>
        </Select>
        <span className="text-xs text-fg-muted">{total} total</span>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={load}>
          <Clock size={14} />
        </Button>
      </div>

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
          title="No feature requests"
          description={filter ? `No requests with status "${filter}"` : 'No feature requests submitted yet'}
        />
      )}

      {/* Table */}
      {!loading && requests.length > 0 && (
        <div className="bg-surface-raised border border-edge rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-sunken text-fg-muted">
              <tr>
                <th className="text-left px-3 py-2 w-10">#</th>
                <th className="text-left px-3 py-2">Title</th>
                <th className="text-left px-3 py-2 w-20">Status</th>
                <th className="text-left px-3 py-2 w-20">Priority</th>
                <th className="text-left px-3 py-2 w-32">Submitted By</th>
                <th className="text-left px-3 py-2 w-24">Time</th>
                <th className="text-center px-3 py-2 w-28">Actions</th>
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
                          {statusStyle.label}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`text-xs ${priorityStyle.color}`}>{priorityStyle.label}</span>
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
                                title="Accept"
                              >
                                <Check size={13} />
                              </button>
                              <button
                                onClick={() => handleStatusChange(r.id, 'rejected')}
                                disabled={isSaving}
                                className="p-1 text-fg-muted hover:text-danger hover:bg-danger-subtle rounded transition-colors"
                                title="Reject"
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
                              title="Mark Done"
                            >
                              <CheckCircle size={13} />
                            </button>
                          )}
                          {(r.status === 'rejected' || r.status === 'done') && (
                            <button
                              onClick={() => handleStatusChange(r.id, 'pending')}
                              disabled={isSaving}
                              className="p-1 text-fg-muted hover:text-warning hover:bg-warning-subtle rounded transition-colors"
                              title="Reopen"
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
                            <option value="low">Low</option>
                            <option value="normal">Normal</option>
                            <option value="high">High</option>
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
                                View session →
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
                                    placeholder="Admin note..."
                                  />
                                  <div className="flex gap-2 justify-end">
                                    <Button variant="ghost" size="sm" onClick={() => setEditingNote(null)}>
                                      Cancel
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
                                      Admin Note
                                    </span>
                                    {r.admin_note ? (
                                      <p className="text-sm text-fg-secondary mt-0.5">{r.admin_note}</p>
                                    ) : (
                                      <p className="text-xs text-fg-faint mt-0.5">No note yet</p>
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
                                    {r.admin_note ? 'Edit' : '+ Add Note'}
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
  );
}
