/**
 * Automations panel — table-based layout for scheduled tasks.
 *
 * CRUD for scheduled tasks with enable/disable toggle,
 * manual trigger, and execution history links.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Button,
  Spinner,
  Dialog,
  Input,
  Select,
  Textarea,
  EmptyState,
  ListToolbar,
  Toggle,
  StatusDot,
  Badge,
  toast,
} from '../../components/ui';
import { Play, Pencil, Trash2, Plus, Clock, History, Zap } from '../../lib/icons';
import * as api from '../../lib/api';
import type { ScheduledTask, ScheduledTaskInput } from '../../lib/api';
import { useT } from '../../lib/i18n';

// ─── Schedule builder ────────────────────────────────────
//
// Friendly schedule editor: frequency + time (+ weekdays / day of
// month) that compiles to a standard 5-field cron expression.
// Expressions that don't fit these shapes fall back to raw cron.

type Frequency = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'cron';

interface ScheduleState {
  freq: Frequency;
  time: string; // "HH:MM"
  weekdays: number[]; // 0 (Sun) – 6 (Sat), for freq=weekly
  monthDay: number; // 1–31, for freq=monthly
  raw: string; // for freq=cron
}

const WEEKDAY_KEYS = [
  'weekdaySun',
  'weekdayMon',
  'weekdayTue',
  'weekdayWed',
  'weekdayThu',
  'weekdayFri',
  'weekdaySat',
] as const;

function buildCron(s: ScheduleState): string {
  if (s.freq === 'cron') return s.raw;
  const [h, m] = s.time.split(':').map((n) => parseInt(n, 10));
  const min = isNaN(m) ? 0 : m;
  const hr = isNaN(h) ? 0 : h;
  switch (s.freq) {
    case 'daily':
      return `${min} ${hr} * * *`;
    case 'weekdays':
      return `${min} ${hr} * * 1-5`;
    case 'weekly': {
      const days = [...s.weekdays].sort((a, b) => a - b);
      return `${min} ${hr} * * ${days.length ? days.join(',') : '1'}`;
    }
    case 'monthly':
      return `${min} ${hr} ${s.monthDay} * *`;
  }
}

function parseCron(cron: string): ScheduleState {
  const fallback: ScheduleState = { freq: 'cron', time: '09:00', weekdays: [1], monthDay: 1, raw: cron };
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return fallback;
  const [min, hr, dom, mon, dow] = parts;
  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hr) || mon !== '*') return fallback;
  const time = `${hr.padStart(2, '0')}:${min.padStart(2, '0')}`;
  const base = { time, weekdays: [1], monthDay: 1, raw: cron };
  if (dom === '*' && dow === '*') return { ...base, freq: 'daily' };
  if (dom === '*' && dow === '1-5') return { ...base, freq: 'weekdays' };
  if (dom === '*' && /^[0-7](,[0-7])*$/.test(dow)) {
    const weekdays = [...new Set(dow.split(',').map((d) => parseInt(d, 10) % 7))].sort((a, b) => a - b);
    return { ...base, freq: 'weekly', weekdays };
  }
  if (dow === '*' && /^\d{1,2}$/.test(dom)) {
    const day = parseInt(dom, 10);
    if (day >= 1 && day <= 31) return { ...base, freq: 'monthly', monthDay: day };
  }
  return fallback;
}

function describeSchedule(s: ScheduleState, t: (key: any, vars?: any) => string): string {
  switch (s.freq) {
    case 'daily':
      return t('automations.descDaily', { time: s.time });
    case 'weekdays':
      return t('automations.descWeekdays', { time: s.time });
    case 'weekly': {
      const days = (s.weekdays.length ? s.weekdays : [1]).map((d) => t(`automations.${WEEKDAY_KEYS[d]}`)).join(', ');
      return t('automations.descWeekly', { days, time: s.time });
    }
    case 'monthly':
      return t('automations.descMonthly', { day: s.monthDay, time: s.time });
    case 'cron':
      return '';
  }
}

// ─── Task Editor Dialog ──────────────────────────────────

interface TaskEditorProps {
  task?: ScheduledTask | null;
  profiles: api.Profile[];
  onSave: (input: ScheduledTaskInput) => Promise<void>;
  onClose: () => void;
}

function TaskEditor({ task, profiles, onSave, onClose }: TaskEditorProps) {
  const t = useT();
  const [name, setName] = useState(task?.name ?? '');
  const [profileId, setProfileId] = useState(task?.profile_id ?? 'default');
  const [prompt, setPrompt] = useState(task?.task_prompt ?? '');
  const [sched, setSched] = useState<ScheduleState>(() => parseCron(task?.schedule ?? '0 22 * * *'));
  const [timezone, setTimezone] = useState(task?.timezone ?? 'UTC');
  const [maxSteps, setMaxSteps] = useState(task?.max_steps ?? 15);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const schedule = buildCron(sched);
  const patch = (p: Partial<ScheduleState>) => setSched((s) => ({ ...s, ...p }));

  const FREQ_OPTIONS: { value: Frequency; labelKey: string }[] = [
    { value: 'daily', labelKey: 'automations.freqDaily' },
    { value: 'weekdays', labelKey: 'automations.freqWeekdays' },
    { value: 'weekly', labelKey: 'automations.freqWeekly' },
    { value: 'monthly', labelKey: 'automations.freqMonthly' },
    { value: 'cron', labelKey: 'automations.freqCron' },
  ];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await onSave({
        name,
        profile_id: profileId,
        task_prompt: prompt,
        schedule,
        timezone,
        max_steps: maxSteps,
      });
      onClose();
    } catch (err: any) {
      setError(err.message || t('automations.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={task ? t('automations.editTitle') : t('automations.createTitle')}
      size="lg"
      noPadding
    >
      <form onSubmit={handleSubmit}>
        <div className="px-6 py-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-fg-secondary mb-1">{t('automations.taskName')} *</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('automations.taskNamePlaceholder')}
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-fg-secondary mb-1">{t('automations.profile')}</label>
            <Select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            <p className="text-xs text-fg-muted mt-1">{t('automations.profileHint')}</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-fg-secondary mb-1">{t('automations.taskPrompt')} *</label>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t('automations.taskPromptPlaceholder')}
              rows={5}
              required
              className="font-mono text-sm"
            />
            <p className="text-xs text-fg-muted mt-1">{prompt.length} / 4000</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-fg-secondary mb-1">{t('automations.schedule')} *</label>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {FREQ_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => patch({ freq: opt.value, raw: opt.value === 'cron' ? schedule : sched.raw })}
                  className={`px-2.5 py-1 rounded-md text-xs transition-colors ${
                    sched.freq === opt.value
                      ? 'bg-primary-subtle text-primary-fg-strong border border-primary-edge'
                      : 'bg-surface-sunken text-fg-muted border border-edge hover:text-fg-secondary'
                  }`}
                >
                  {t(opt.labelKey as any)}
                </button>
              ))}
            </div>
            {sched.freq === 'cron' ? (
              <div>
                <Input
                  value={sched.raw}
                  onChange={(e) => patch({ raw: e.target.value })}
                  placeholder="0 22 * * *"
                  className="font-mono"
                />
                <p className="text-xs text-fg-muted mt-1">{t('automations.cronHint')}</p>
              </div>
            ) : (
              <div className="space-y-3">
                {sched.freq === 'weekly' && (
                  <div className="flex flex-wrap gap-1.5">
                    {[1, 2, 3, 4, 5, 6, 0].map((d) => {
                      const active = sched.weekdays.includes(d);
                      return (
                        <button
                          key={d}
                          type="button"
                          onClick={() =>
                            patch({
                              weekdays: active ? sched.weekdays.filter((w) => w !== d) : [...sched.weekdays, d],
                            })
                          }
                          className={`w-10 py-1.5 rounded-md text-xs transition-colors ${
                            active
                              ? 'bg-primary-subtle text-primary-fg-strong border border-primary-edge font-medium'
                              : 'bg-surface-sunken text-fg-muted border border-edge hover:text-fg-secondary'
                          }`}
                        >
                          {t(`automations.${WEEKDAY_KEYS[d]}` as any)}
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="flex items-center gap-4">
                  {sched.freq === 'monthly' && (
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-fg-secondary whitespace-nowrap">
                        {t('automations.monthDayLabel')}
                      </span>
                      <Select
                        value={String(sched.monthDay)}
                        onChange={(e) => patch({ monthDay: parseInt(e.target.value, 10) })}
                        className="w-24"
                      >
                        {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                          <option key={d} value={d}>
                            {t('automations.monthDayOption', { day: d })}
                          </option>
                        ))}
                      </Select>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-fg-secondary whitespace-nowrap">{t('automations.timeLabel')}</span>
                    <Input
                      type="time"
                      value={sched.time}
                      onChange={(e) => e.target.value && patch({ time: e.target.value })}
                      className="w-32"
                    />
                  </div>
                </div>
                <p className="text-xs text-fg-muted">
                  {describeSchedule(sched, t)}
                  <span className="ml-2 font-mono text-fg-faint">{schedule}</span>
                </p>
              </div>
            )}
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer text-fg-muted hover:text-fg-secondary">
              {t('automations.advancedSettings')}
            </summary>
            <div className="mt-2 space-y-3 pl-2 border-l-2 border-edge">
              <div>
                <label className="block text-xs font-medium text-fg-secondary mb-1">{t('automations.maxSteps')}</label>
                <Input
                  type="number"
                  value={maxSteps}
                  onChange={(e) => setMaxSteps(parseInt(e.target.value) || 15)}
                  min={1}
                  max={20}
                  className="w-24"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-fg-secondary mb-1">{t('automations.timezone')}</label>
                <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="UTC" />
              </div>
            </div>
          </details>
          {error && <p className="text-sm text-danger-fg">{error}</p>}
        </div>
        <div className="px-6 py-4 border-t border-edge flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={saving || !name || !prompt || !schedule}>
            {saving ? <Spinner className="text-white" /> : task ? t('common.save') : t('automations.createAndEnable')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ─── Main Panel ──────────────────────────────────────────

export function AutomationsPanel() {
  const t = useT();
  const [tasks, setTasks] = useState<(ScheduledTask & { schedule_desc?: string })[]>([]);
  const [profiles, setProfiles] = useState<api.Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<ScheduledTask | null>(null);
  const [runningIds, setRunningIds] = useState<Set<number>>(new Set());

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [taskData, profileData] = await Promise.all([api.listTasks(), api.fetchProfiles()]);
      setTasks(taskData);
      setProfiles(profileData);
    } catch (err) {
      console.error('Failed to load tasks:', err);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleCreate = async (input: ScheduledTaskInput) => {
    await api.createTask(input);
    await loadData();
  };

  const handleUpdate = async (input: ScheduledTaskInput) => {
    if (!editingTask) return;
    await api.updateTask(editingTask.id, input);
    await loadData();
  };

  const handleToggle = async (task: ScheduledTask) => {
    await api.updateTask(task.id, { enabled: !task.enabled });
    await loadData();
  };

  const handleRun = async (task: ScheduledTask) => {
    setRunningIds((prev) => new Set(prev).add(task.id));
    try {
      const result = await api.runTask(task.id);
      window.location.hash = `#/chat/${result.session_id}`;
    } catch (err: any) {
      toast(err.message || t('automations.runFailed'), 'error');
    } finally {
      setRunningIds((prev) => {
        const next = new Set(prev);
        next.delete(task.id);
        return next;
      });
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    await api.deleteTask(deleteConfirm.id);
    setDeleteConfirm(null);
    await loadData();
  };

  const handleViewHistory = (task: ScheduledTask) => {
    window.location.hash = `#/history?task=${task.id}`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner />
      </div>
    );
  }

  const createButton = (
    <Button
      size="sm"
      onClick={() => {
        setEditingTask(null);
        setEditorOpen(true);
      }}
    >
      <Plus size={14} className="mr-1" />
      {t('automations.create')}
    </Button>
  );

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <ListToolbar count={t('automations.countLabel', { count: tasks.length })} actions={createButton} />

      {/* Empty state */}
      {tasks.length === 0 ? (
        <EmptyState
          icon={Zap}
          title={t('automations.noneTitle')}
          description={t('automations.noneDesc')}
          action={createButton}
        />
      ) : (
        <div className="bg-surface-raised border border-edge rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-sunken text-fg-muted">
              <tr>
                <th className="text-left px-3 py-2">{t('automations.colTask')}</th>
                <th className="text-left px-3 py-2 w-32">{t('automations.colSchedule')}</th>
                <th className="text-left px-3 py-2 w-24">{t('automations.colProfile')}</th>
                <th className="text-center px-3 py-2 w-16">{t('automations.colStatus')}</th>
                <th className="text-right px-3 py-2 w-16">{t('automations.colRuns')}</th>
                <th className="text-left px-3 py-2 w-36">{t('automations.colLastRun')}</th>
                <th className="text-center px-3 py-2 w-28">{t('automations.colActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge">
              {tasks.map((task) => {
                const lastStatusColor =
                  task.last_status === 'completed' ? 'success' : task.last_status === 'failed' ? 'danger' : 'muted';
                return (
                  <tr key={task.id} className="hover:bg-surface-sunken transition-colors">
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-fg truncate max-w-xs" title={task.name}>
                        {task.name}
                      </div>
                      <div className="text-xs text-fg-faint line-clamp-1 mt-0.5">{task.task_prompt}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1 text-xs text-fg-secondary">
                        <Clock size={11} />
                        {task.schedule_desc || task.schedule}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge variant="secondary">
                        {profiles.find((p) => p.id === task.profile_id)?.name || task.profile_id}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex justify-center">
                        <Toggle checked={task.enabled} onChange={() => handleToggle(task)} />
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs text-fg-secondary">{task.run_count}</td>
                    <td className="px-3 py-2.5 text-xs text-fg-muted">
                      {task.last_run_at ? (
                        <span className="inline-flex items-center gap-1.5">
                          <StatusDot color={lastStatusColor} size="sm" />
                          {new Date(task.last_run_at).toLocaleString('zh-CN', { timeZone: task.timezone })}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => handleRun(task)}
                          disabled={runningIds.has(task.id)}
                          className="p-1 text-fg-muted hover:text-primary-fg hover:bg-primary-subtle rounded transition-colors disabled:opacity-40"
                          title={t('automations.runNow')}
                        >
                          {runningIds.has(task.id) ? <Spinner className="w-3.5 h-3.5" /> : <Play size={13} />}
                        </button>
                        <button
                          onClick={() => handleViewHistory(task)}
                          className="p-1 text-fg-muted hover:text-fg-secondary hover:bg-surface-sunken rounded transition-colors"
                          title={t('automations.viewHistory')}
                        >
                          <History size={13} />
                        </button>
                        <button
                          onClick={() => {
                            setEditingTask(task);
                            setEditorOpen(true);
                          }}
                          className="p-1 text-fg-muted hover:text-fg-secondary hover:bg-surface-sunken rounded transition-colors"
                          title={t('common.edit')}
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={() => setDeleteConfirm(task)}
                          className="p-1 text-fg-muted hover:text-danger hover:bg-danger-subtle rounded transition-colors"
                          title={t('common.delete')}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Task editor modal */}
      {editorOpen && (
        <TaskEditor
          task={editingTask}
          profiles={profiles}
          onSave={editingTask ? handleUpdate : handleCreate}
          onClose={() => {
            setEditorOpen(false);
            setEditingTask(null);
          }}
        />
      )}

      {/* Delete confirmation */}
      {deleteConfirm && (
        <Dialog open onClose={() => setDeleteConfirm(null)} title={t('automations.deleteTaskTitle')} size="sm">
          <div className="space-y-4">
            <p className="text-sm text-fg-secondary">
              {t('automations.deleteTaskConfirm', { name: deleteConfirm.name })}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDeleteConfirm(null)}>
                {t('common.cancel')}
              </Button>
              <Button variant="destructive" onClick={handleDelete}>
                {t('common.delete')}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
