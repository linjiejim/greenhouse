/**
 * 任务详情抽屉 — 查看/编辑任务信息、管理评论。
 */

import React, { useState, useEffect } from 'react';
import { Button, Input, Select, Spinner, Textarea, Drawer, ConfirmDialog, toast } from '../ui';
import { authFetch } from '../../lib/auth';
import { timeAgo } from '../../lib/utils';
import {
  Calendar,
  User,
  Clock,
  MessageSquare,
  Send,
  Trash2,
  Edit3,
  Tag,
  ChevronRight,
  Plus,
  X,
  ArrowRight,
  Link,
} from '../../lib/icons';
import { StatusIcon } from './task-tree';
import { statusConfig } from './types';
import type { Task, Comment } from './types';
import { useT } from '../../lib/i18n';
import { Markdown } from '../markdown';

export function TaskDetailDrawer({
  task,
  open,
  onClose,
  onUpdate,
  users,
  allTasks,
}: {
  task: Task | null;
  open: boolean;
  onClose: () => void;
  onUpdate: () => void;
  users: Array<{ id: string; nickname: string }>;
  allTasks: Task[];
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<any>({});
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [saving, setSaving] = useState(false);
  const [loadingComments, setLoadingComments] = useState(false);
  const [editDeps, setEditDeps] = useState(false);
  const [depSearch, setDepSearch] = useState('');

  // Load comments when task changes
  useEffect(() => {
    if (!task) return;
    setEditing(false);
    setEditDeps(false);
    setDepSearch('');
    const deps =
      typeof task.dependencies === 'string' ? JSON.parse(task.dependencies || '[]') : task.dependencies || [];
    setForm({
      title: task.title,
      description: task.description || '',
      status: task.status,
      priority: task.priority,
      assignee_id: task.assignee_id || '',
      start_date: task.start_date || '',
      due_date: task.due_date || '',
      estimated_hours: task.estimated_hours ?? '',
      tags: typeof task.tags === 'string' ? JSON.parse(task.tags || '[]').join(', ') : (task.tags || []).join(', '),
      dependencies: deps,
    });
    loadComments(task.id);
  }, [task?.id]);

  const loadComments = async (taskId: number) => {
    setLoadingComments(true);
    try {
      const res = await authFetch(`/api/projects/tasks/${taskId}/comments`);
      if (res.ok) {
        const data = await res.json();
        setComments(data.comments);
      }
    } catch (_err) {
      /* ignore */
    }
    setLoadingComments(false);
  };

  const handleSave = async () => {
    if (!task) return;
    setSaving(true);
    try {
      const tags = form.tags
        ? form.tags
            .split(',')
            .map((t: string) => t.trim())
            .filter(Boolean)
        : [];
      const res = await authFetch(`/api/projects/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title,
          description: form.description || null,
          status: form.status,
          priority: form.priority,
          assignee_id: form.assignee_id || null,
          start_date: form.start_date || null,
          due_date: form.due_date || null,
          estimated_hours: form.estimated_hours ? parseInt(form.estimated_hours) : null,
          tags,
          dependencies: form.dependencies || [],
        }),
      });
      if (res.ok) {
        setEditing(false);
        onUpdate();
      }
    } catch (_err) {
      /* ignore */
    }
    setSaving(false);
  };

  const handleQuickStatus = async (newStatus: string) => {
    if (!task) return;
    const oldStatus = task.status;
    // Optimistic: update local form state immediately
    setForm((prev: any) => ({ ...prev, status: newStatus }));
    // Fire server update (non-blocking)
    authFetch(`/api/projects/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    }).then(() => onUpdate());
    toast(t('projects.statusUpdated'), 'success', {
      onUndo: () => {
        setForm((prev: any) => ({ ...prev, status: oldStatus }));
        authFetch(`/api/projects/tasks/${task.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: oldStatus }),
        }).then(() => onUpdate());
      },
    });
  };

  const handleAddComment = async () => {
    if (!task || !newComment.trim()) return;
    try {
      const res = await authFetch(`/api/projects/tasks/${task.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newComment.trim() }),
      });
      if (res.ok) {
        setNewComment('');
        loadComments(task.id);
      }
    } catch (_err) {
      /* ignore */
    }
  };

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const handleDelete = async () => {
    if (!task) return;
    setShowDeleteConfirm(false);
    await authFetch(`/api/projects/tasks/${task.id}`, { method: 'DELETE' });
    toast(t('task.deleted'), 'success');
    onClose();
    onUpdate();
  };

  if (!task) return null;

  const parentTask = task.parent_id ? allTasks.find((t) => t.id === task.parent_id) : null;
  const subtasks = allTasks.filter((t) => t.parent_id === task.id);

  return (
    <>
      <Drawer open={open} onClose={onClose} side="right" width="40%">
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
            <div className="flex items-center gap-2">
              <StatusIcon status={task.status} size={16} />
              <span className="text-xs text-fg-faint">#{task.id}</span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setEditing(!editing)}
                className="p-1.5 text-fg-faint hover:text-primary-fg rounded hover:bg-surface-muted"
              >
                <Edit3 size={14} />
              </button>
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="p-1.5 text-fg-faint hover:text-danger rounded hover:bg-surface-muted"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
            {editing ? (
              /* Edit form */
              <div className="space-y-3">
                <Input
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder={t('task.taskTitleLabel')}
                />
                <Textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder={t('task.descriptionMarkdown')}
                  rows={4}
                />
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-fg-muted mb-0.5 block">{t('common.status')}</label>
                    <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                      {Object.entries(statusConfig).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <label className="text-[10px] text-fg-muted mb-0.5 block">{t('common.priority')}</label>
                    <Select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                      <option value="low">Low</option>
                      <option value="normal">Normal</option>
                      <option value="high">High</option>
                      <option value="urgent">Urgent</option>
                    </Select>
                  </div>
                </div>
                <div>
                  <label className="text-[10px] text-fg-muted mb-0.5 block">{t('common.assignee')}</label>
                  <Select value={form.assignee_id} onChange={(e) => setForm({ ...form, assignee_id: e.target.value })}>
                    <option value="">{t('common.unassigned')}</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.nickname}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-fg-muted mb-0.5 block">{t('common.startDate')}</label>
                    <Input
                      type="date"
                      value={form.start_date}
                      onChange={(e) => setForm({ ...form, start_date: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-fg-muted mb-0.5 block">{t('common.dueDate')}</label>
                    <Input
                      type="date"
                      value={form.due_date}
                      onChange={(e) => setForm({ ...form, due_date: e.target.value })}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-fg-muted mb-0.5 block">{t('task.estimatedHours')}</label>
                    <Input
                      type="number"
                      value={form.estimated_hours}
                      onChange={(e) => setForm({ ...form, estimated_hours: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-fg-muted mb-0.5 block">{t('task.tagsComma')}</label>
                    <Input
                      value={form.tags}
                      onChange={(e) => setForm({ ...form, tags: e.target.value })}
                      placeholder="tag1, tag2"
                    />
                  </div>
                </div>
                <div className="flex gap-2 justify-end">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                    {t('common.cancel')}
                  </Button>
                  <Button size="sm" onClick={handleSave} disabled={saving}>
                    {saving ? t('common.saving') : t('common.save')}
                  </Button>
                </div>
              </div>
            ) : (
              /* Read view */
              <>
                <h2 className="text-base font-semibold text-fg">{task.title}</h2>

                {/* Quick status change */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  {Object.entries(statusConfig).map(([key, cfg]) => (
                    <button
                      key={key}
                      onClick={() => handleQuickStatus(key)}
                      className={`text-[10px] px-2 py-1 rounded-full border transition-colors ${
                        (form.status || task.status) === key
                          ? `${cfg.bg} font-medium`
                          : 'border-edge text-fg-faint hover:border-edge-strong'
                      }`}
                    >
                      {cfg.label}
                    </button>
                  ))}
                </div>

                {/* Meta info */}
                <div className="space-y-2 text-xs">
                  <div className="flex items-center gap-2 text-fg-muted">
                    <User size={12} />
                    <span className="text-fg-faint w-12">{t('common.assignee')}</span>
                    <span className="text-fg-secondary">{task.assignee_nickname || t('common.unassigned')}</span>
                  </div>
                  {task.due_date && (
                    <div className="flex items-center gap-2 text-fg-muted">
                      <Calendar size={12} />
                      <span className="text-fg-faint w-12">{t('common.dueDate')}</span>
                      <span className="text-fg-secondary">{task.due_date}</span>
                    </div>
                  )}
                  {task.start_date && (
                    <div className="flex items-center gap-2 text-fg-muted">
                      <Calendar size={12} />
                      <span className="text-fg-faint w-12">{t('common.startDate')}</span>
                      <span className="text-fg-secondary">{task.start_date}</span>
                    </div>
                  )}
                  {task.estimated_hours && (
                    <div className="flex items-center gap-2 text-fg-muted">
                      <Clock size={12} />
                      <span className="text-fg-faint w-12">{t('task.estimatedHours')}</span>
                      <span className="text-fg-secondary">{task.estimated_hours}h</span>
                    </div>
                  )}
                  {parentTask && (
                    <div className="flex items-center gap-2 text-fg-muted">
                      <ChevronRight size={12} />
                      <span className="text-fg-faint w-12">{t('task.parentTask')}</span>
                      <span className="text-primary-fg">{parentTask.title}</span>
                    </div>
                  )}
                  {(() => {
                    const tags = typeof task.tags === 'string' ? JSON.parse(task.tags || '[]') : task.tags || [];
                    return (
                      tags.length > 0 && (
                        <div className="flex items-center gap-2 text-fg-muted">
                          <Tag size={12} />
                          <span className="text-fg-faint w-12">{t('common.tags')}</span>
                          <div className="flex gap-1 flex-wrap">
                            {tags.map((tag: string) => (
                              <span
                                key={tag}
                                className="text-[10px] bg-surface-muted text-fg-secondary px-1.5 py-0.5 rounded"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        </div>
                      )
                    );
                  })()}
                </div>

                {/* Description (Markdown) */}
                {task.description && (
                  <div>
                    <h4 className="text-xs font-medium text-fg-secondary mb-1">{t('common.description')}</h4>
                    <div className="bg-surface-sunken rounded-lg p-3">
                      <Markdown content={task.description} compact />
                    </div>
                  </div>
                )}

                {/* Dependencies (Feature 8) */}
                {(() => {
                  const deps: number[] =
                    typeof task.dependencies === 'string'
                      ? JSON.parse(task.dependencies || '[]')
                      : task.dependencies || [];
                  const depTasks = deps.map((id) => allTasks.find((t) => t.id === id)).filter(Boolean) as Task[];
                  const dependents = allTasks.filter((t) => {
                    const tDeps =
                      typeof t.dependencies === 'string' ? JSON.parse(t.dependencies || '[]') : t.dependencies || [];
                    return tDeps.includes(task.id);
                  });
                  return (
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <h4 className="text-xs font-medium text-fg-secondary flex items-center gap-1">
                          <Link size={12} />
                          {t('task.dependencies')}
                        </h4>
                        <button
                          onClick={() => setEditDeps(!editDeps)}
                          className="text-[10px] text-primary-fg hover:text-primary-fg-strong"
                        >
                          {editDeps ? t('task.doneDeps') : t('task.editDeps')}
                        </button>
                      </div>
                      {/* Predecessors (blocks this task) */}
                      {(depTasks.length > 0 || editDeps) && (
                        <div className="mb-2">
                          <span className="text-[10px] text-fg-faint mb-1 block">{t('task.blockers')}</span>
                          <div className="space-y-1">
                            {depTasks.map((dt) => (
                              <div key={dt.id} className="flex items-center gap-1.5 text-xs py-0.5 group">
                                <ArrowRight size={10} className="text-warning" />
                                <StatusIcon status={dt.status} size={10} />
                                <span className="text-fg-secondary truncate flex-1" title={dt.title}>
                                  {dt.title}
                                </span>
                                {editDeps && (
                                  <button
                                    onClick={async () => {
                                      const newDeps = deps.filter((d) => d !== dt.id);
                                      await authFetch(`/api/projects/tasks/${task.id}`, {
                                        method: 'PATCH',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ dependencies: newDeps }),
                                      });
                                      onUpdate();
                                    }}
                                    className="text-fg-faint hover:text-danger opacity-0 group-hover:opacity-100 flex-shrink-0"
                                  >
                                    <X size={12} />
                                  </button>
                                )}
                              </div>
                            ))}
                            {editDeps && (
                              <div className="mt-1">
                                <Input
                                  type="text"
                                  placeholder={t('task.searchTasksToAdd')}
                                  value={depSearch}
                                  onChange={(e) => setDepSearch(e.target.value)}
                                  className=""
                                  size="xs"
                                />
                                {depSearch && (
                                  <div className="border border-edge rounded mt-0.5 max-h-[120px] overflow-y-auto bg-surface-raised shadow-sm">
                                    {allTasks
                                      .filter(
                                        (t) =>
                                          t.id !== task.id &&
                                          !deps.includes(t.id) &&
                                          t.title.toLowerCase().includes(depSearch.toLowerCase()),
                                      )
                                      .slice(0, 8)
                                      .map((t) => (
                                        <button
                                          key={t.id}
                                          onClick={async () => {
                                            const newDeps = [...deps, t.id];
                                            await authFetch(`/api/projects/tasks/${task.id}`, {
                                              method: 'PATCH',
                                              headers: { 'Content-Type': 'application/json' },
                                              body: JSON.stringify({ dependencies: newDeps }),
                                            });
                                            setDepSearch('');
                                            onUpdate();
                                          }}
                                          className="w-full text-left px-2 py-1 text-xs hover:bg-primary-subtle flex items-center gap-1.5"
                                        >
                                          <Plus size={10} className="text-primary-500" />
                                          <StatusIcon status={t.status} size={10} />
                                          <span className="truncate" title={t.title}>
                                            {t.title}
                                          </span>
                                        </button>
                                      ))}
                                    {allTasks.filter(
                                      (t) =>
                                        t.id !== task.id &&
                                        !deps.includes(t.id) &&
                                        t.title.toLowerCase().includes(depSearch.toLowerCase()),
                                    ).length === 0 && (
                                      <div className="px-2 py-1 text-[10px] text-fg-faint">
                                        {t('task.noMatchingTasks')}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                      {/* Dependents (this task blocks them) */}
                      {dependents.length > 0 && (
                        <div>
                          <span className="text-[10px] text-fg-faint mb-1 block">{t('task.dependents')}</span>
                          <div className="space-y-1">
                            {dependents.map((dt) => (
                              <div key={dt.id} className="flex items-center gap-1.5 text-xs py-0.5">
                                <ArrowRight size={10} className="text-info" />
                                <StatusIcon status={dt.status} size={10} />
                                <span className="text-fg-secondary truncate" title={dt.title}>
                                  {dt.title}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {depTasks.length === 0 && dependents.length === 0 && !editDeps && (
                        <p className="text-[10px] text-fg-faint">{t('task.noDependencies')}</p>
                      )}
                    </div>
                  );
                })()}

                {/* Subtasks */}
                {subtasks.length > 0 && (
                  <div>
                    <h4 className="text-xs font-medium text-fg-secondary mb-1.5">
                      {t('task.subtasks')} ({subtasks.length})
                    </h4>
                    <div className="space-y-1">
                      {subtasks.map((st) => (
                        <div key={st.id} className="flex items-center gap-2 text-xs py-1">
                          <StatusIcon status={st.status} size={12} />
                          <span className={st.status === 'done' ? 'line-through text-fg-faint' : 'text-fg-secondary'}>
                            {st.title}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Comments */}
            <div className="border-t border-edge pt-3">
              <h4 className="text-xs font-medium text-fg-secondary mb-2 flex items-center gap-1">
                <MessageSquare size={12} />
                {t('task.comments')} {comments.length > 0 && `(${comments.length})`}
              </h4>
              {loadingComments ? (
                <Spinner className="text-primary-fg" />
              ) : (
                <div className="space-y-2">
                  {comments.map((cm) => (
                    <div key={cm.id} className="bg-surface-sunken rounded-lg p-2.5">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] font-medium text-fg-secondary">{cm.user_nickname}</span>
                        <span className="text-[10px] text-fg-faint">{timeAgo(cm.created_at)}</span>
                      </div>
                      <p className="text-xs text-fg-secondary whitespace-pre-wrap">{cm.content}</p>
                    </div>
                  ))}
                </div>
              )}
              {/* New comment input */}
              <div className="flex gap-2 mt-2">
                <Input
                  type="text"
                  placeholder="Write a comment..."
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleAddComment();
                    }
                  }}
                  className="flex-1 text-xs px-3 py-2 border border-edge rounded-lg focus:outline-none focus:ring-1 focus:ring-primary-500"
                />
                <button
                  onClick={handleAddComment}
                  disabled={!newComment.trim()}
                  className="p-2 text-primary-fg hover:bg-primary-subtle rounded-lg disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <Send size={14} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </Drawer>

      <ConfirmDialog
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title={t('task.deleteConfirm')}
        description={t('task.deleteConfirmDesc')}
        confirmLabel={t('common.delete')}
        confirmVariant="destructive"
      />
    </>
  );
}
