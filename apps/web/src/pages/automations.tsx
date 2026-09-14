/**
 * Automations panel — scheduled tasks, driven by one @greenhouse/crud schema.
 *
 * The list (table + toolbar + delete-confirm), the add/edit Dialog,
 * enable/disable, and the Run-now row action all come from
 * `defineCrud`. The only bespoke piece is the friendly cron builder, embedded
 * as a `custom` form field. Data source adapts the existing tasks client —
 * no server change.
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { defineCrud, CrudPage, type CrudDataSource, type CrudFieldRenderProps, type FieldDef } from './settings/crud';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  FilterPills,
  Input,
  Select,
  Spinner,
  Tag,
  Textarea,
  Toggle,
  toast,
  type TagTone,
} from '../components/ui';
import { AlertTriangle, CheckCircle, Clock, History, Play, Plus, Zap, XCircle } from '../lib/icons';
import * as api from '../lib/api';
import type { ScheduledTask, ScheduledTaskInput } from '../lib/api';
import type { AutomationRunEntry } from '@greenhouse/types/api';
import {
  AUTOMATION_OPT_IN_TOOLS,
  normalizeAutomationOptInTools,
  type AutomationOptInTier,
} from '@greenhouse/types/automation-tools';
import { useT } from '../lib/i18n';
import { formatDate, formatDateInZone } from '../lib/utils';
import { fetchWeComBinding } from '../lib/api/wecom';
import { fetchFeishuBinding } from '../lib/api/feishu';
import { useAuthStore } from '../stores';
import { assetScopeItems, DEFAULT_ASSET_SCOPE, filterAutomationsByScope, type AssetScope } from '../lib/asset-scopes';
import { ModulePage } from '../components/app/module-page';

type Task = ScheduledTask & { schedule_desc?: string };

// ─── Schedule builder ────────────────────────────────────
//
// Friendly schedule editor: frequency + time (+ weekdays / day of
// month) that compiles to a standard 5-field cron expression.
// Expressions that don't fit these shapes fall back to raw cron.
// Embedded as a `custom` CRUD field below.

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

/** Cron builder wired as a `custom` CRUD field: value is the cron string. */
function ScheduleField({ value, onChange }: CrudFieldRenderProps) {
  const t = useT();
  const [sched, setSched] = useState<ScheduleState>(() => parseCron(String(value ?? '0 22 * * *')));
  const schedule = buildCron(sched);

  // Keep the form value in sync with the builder (initial + every change).
  useEffect(() => {
    onChange(schedule);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedule]);

  const patch = (p: Partial<ScheduleState>) => setSched((s) => ({ ...s, ...p }));

  const FREQ_OPTIONS: { value: Frequency; labelKey: string }[] = [
    { value: 'daily', labelKey: 'automations.freqDaily' },
    { value: 'weekdays', labelKey: 'automations.freqWeekdays' },
    { value: 'weekly', labelKey: 'automations.freqWeekly' },
    { value: 'monthly', labelKey: 'automations.freqMonthly' },
    { value: 'cron', labelKey: 'automations.freqCron' },
  ];

  return (
    <div>
      {/* Selection is announced, not just tinted: `aria-pressed` matches what these
          buttons actually do (Tab to reach, Space/Enter to activate). Declaring
          role="radio" would promise arrow-key roving these don't implement. */}
      <div className="flex flex-wrap gap-1.5 mb-3" role="group" aria-label={t('automations.freqGroupLabel')}>
        {FREQ_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            aria-pressed={sched.freq === opt.value}
            onClick={() => patch({ freq: opt.value, raw: opt.value === 'cron' ? schedule : sched.raw })}
            className={`px-2.5 py-1 rounded-md text-xs transition-colors ${
              sched.freq === opt.value
                ? 'bg-primary-subtle text-primary-fg-strong border border-primary-edge font-medium'
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
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('automations.weekdayGroupLabel')}>
              {[1, 2, 3, 4, 5, 6, 0].map((d) => {
                const active = sched.weekdays.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      patch({ weekdays: active ? sched.weekdays.filter((w) => w !== d) : [...sched.weekdays, d] })
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
          <div className="flex flex-wrap items-start gap-4">
            {sched.freq === 'monthly' && (
              <div className="space-y-1">
                <div className="text-xs font-medium text-fg-secondary">{t('automations.monthDayLabel')}</div>
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
            <div className="space-y-1">
              <div className="text-xs font-medium text-fg-secondary">{t('automations.timeLabel')}</div>
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
  );
}

// ─── Run history dialog ──────────────────────────────────

/**
 * The stored grant is a JSON string on the row; the form edits a list. Normalise
 * on the way out so an untouched form does not post the raw string back (the
 * server takes an array and would refuse it).
 */
function withFormDefaults(data: Record<string, unknown>): Partial<ScheduledTaskInput> {
  const { unattended_tools, ...rest } = data;
  return {
    ...rest,
    max_steps: (data.max_steps as number | null) ?? 15,
    unattended_tools: readOptInTools(unattended_tools),
  } as Partial<ScheduledTaskInput>;
}

/** Accepts the stored JSON string, an already-edited array, or nothing. */
function readOptInTools(value: unknown): string[] {
  if (typeof value === 'string') {
    try {
      return normalizeAutomationOptInTools(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return normalizeAutomationOptInTools(value);
}

/**
 * The per-automation tool grant.
 *
 * Only tools the user ALREADY holds are offered: the server intersects the
 * grant with the owner's effective tools on every run, so rendering one they do
 * not have would be a checkbox that silently does nothing.
 *
 * The `write` tier carries an explicit consequence line, and ticking any of it
 * surfaces the combination warning — reading untrusted content (search results,
 * knowledge docs, CRM notes anyone can write) and then writing with nobody
 * reviewing is the least obvious consequence of this screen, so it is stated
 * rather than quietly allowed.
 */
function OptInToolsField({ value, onChange, disabled }: CrudFieldRenderProps) {
  const t = useT();
  const [available, setAvailable] = useState<Set<string> | null>(null);
  const selected = useMemo(() => new Set(readOptInTools(value)), [value]);

  useEffect(() => {
    let alive = true;
    api
      .fetchTools()
      .then((tools) => alive && setAvailable(new Set(tools.map((tool) => tool.id))))
      .catch(() => alive && setAvailable(new Set()));
    return () => {
      alive = false;
    };
  }, []);

  const offered = useMemo(
    () => (available ? AUTOMATION_OPT_IN_TOOLS.filter((tool) => available.has(tool.id)) : []),
    [available],
  );

  if (available === null) return <Spinner />;
  if (offered.length === 0) return <p className="text-xs text-fg-muted">{t('automations.toolsNoneAvailable')}</p>;

  const toggle = (id: string, next: boolean) => {
    const picked = new Set(selected);
    if (next) picked.add(id);
    else picked.delete(id);
    onChange(normalizeAutomationOptInTools([...picked]));
  };

  const tiers: AutomationOptInTier[] = ['assist', 'write'];
  const writesGranted = offered.some((tool) => tool.tier === 'write' && selected.has(tool.id));

  return (
    <div className="space-y-3">
      <p className="text-xs text-fg-muted">{t('automations.toolsHint')}</p>
      {tiers.map((tier) => {
        const group = offered.filter((tool) => tool.tier === tier);
        if (group.length === 0) return null;
        return (
          <div key={tier}>
            <p className="text-xs font-medium text-fg-secondary mb-1.5">
              {tier === 'write' ? t('automations.toolsTierWrite') : t('automations.toolsTierAssist')}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {group.map((tool) => (
                <Checkbox
                  key={tool.id}
                  label={toolLabel(t, tool.id)}
                  checked={selected.has(tool.id)}
                  disabled={disabled}
                  onChange={(e) => toggle(tool.id, e.target.checked)}
                />
              ))}
            </div>
          </div>
        );
      })}
      {writesGranted && (
        <div className="flex gap-2 rounded-md bg-warning-subtle px-3 py-2 text-xs text-fg-secondary">
          <AlertTriangle size={14} className="text-warning shrink-0 mt-0.5" />
          <span>{t('automations.toolsWriteWarning')}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Fall back to the raw tool id when a catalog entry has no label yet: ugly, but
 * a blank checkbox is worse — the user would be granting something unnamed.
 */
function toolLabel(t: ReturnType<typeof useT>, id: string): string {
  // Underscore, not a dot: the resolver treats '.' as a path separator, so a
  // dotted leaf key would never be found.
  const key = `automations.tool_${id}`;
  const label = t(key as Parameters<typeof t>[0]);
  return label === key ? id : label;
}

function runStatusTone(status: string): TagTone {
  if (status === 'succeeded') return 'success';
  if (status === 'failed' || status === 'interrupted') return 'danger';
  if (status === 'waiting' || status === 'paused') return 'warning';
  if (status === 'running' || status === 'claimed') return 'primary';
  return 'neutral';
}

function runDuration(run: NonNullable<AutomationRunEntry['run']>): string | null {
  if (!run.started_at || !run.ended_at) return null;
  const seconds = Math.max(0, Math.round((Date.parse(run.ended_at) - Date.parse(run.started_at)) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

/**
 * Past executions of one automation. Every run — scheduled, manual, legacy
 * pre-Runtime, and enqueue failures — is a `channel='task'` session, so each
 * row opens the conversation that run produced.
 */
function RunHistoryDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const t = useT();
  const [entries, setEntries] = useState<AutomationRunEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listTaskRuns(task.id)
      .then((items) => {
        if (!cancelled) setEntries(items);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : t('automations.historyLoadFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, [task.id, t]);

  const openSession = (sessionId: string) => {
    window.location.hash = `#/chat?session=${encodeURIComponent(sessionId)}`;
  };

  return (
    <Dialog open onClose={onClose} title={t('automations.historyTitle', { name: task.name })} size="workspace">
      {error ? (
        <EmptyState
          variant="compact"
          tone="danger"
          icon={XCircle}
          title={t('automations.historyLoadFailed')}
          description={error}
        />
      ) : entries === null ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          variant="compact"
          icon={History}
          title={t('automations.historyEmpty')}
          description={t('automations.historyEmptyDesc')}
        />
      ) : (
        <table className="w-full min-w-[640px] text-sm [&_th]:whitespace-nowrap [&_td]:whitespace-nowrap">
          <thead className="sticky top-0 z-10 bg-surface-sunken text-fg-muted">
            <tr className="text-left text-xs">
              <th className="px-3 py-2">{t('automations.historyTime')}</th>
              <th className="px-3 py-2">{t('automations.historyTrigger')}</th>
              <th className="px-3 py-2">{t('automations.historyStatus')}</th>
              <th className="px-3 py-2">{t('automations.historyDuration')}</th>
              <th className="px-3 py-2">{t('automations.historyError')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge">
            {entries.map((entry) => (
              <tr
                key={entry.session_id}
                className="cursor-pointer hover:bg-surface-sunken transition-colors"
                title={t('automations.historyOpen')}
                onClick={() => openSession(entry.session_id)}
              >
                <td className="px-3 py-2 text-xs text-fg-secondary">
                  {formatDateInZone(entry.created_at, task.timezone)}
                </td>
                <td className="px-3 py-2 text-xs text-fg-muted">
                  {entry.run
                    ? entry.run.trigger === 'manual'
                      ? t('automations.triggerManual')
                      : t('automations.triggerScheduled')
                    : '—'}
                </td>
                <td className="px-3 py-2">
                  {entry.run ? (
                    <Tag tone={runStatusTone(entry.run.status)}>{entry.run.status}</Tag>
                  ) : (
                    <Tag tone="neutral">{t('automations.historyLegacy')}</Tag>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-fg-muted">{(entry.run && runDuration(entry.run)) ?? '—'}</td>
                <td className="px-3 py-2 text-xs text-danger">
                  {entry.run?.error_message ? (
                    <span className="block max-w-[26rem] truncate" title={entry.run.error_message}>
                      {entry.run.error_message}
                    </span>
                  ) : (
                    <span className="text-fg-faint">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Dialog>
  );
}

// ─── Panel ───────────────────────────────────────────────

export function AutomationsPanel() {
  const t = useT();
  const currentUser = useAuthStore((state) => state.currentUser);
  const isSuper = currentUser?.role === 'super';
  const [scope, setScope] = useState<AssetScope>(DEFAULT_ASSET_SCOPE);
  const [profiles, setProfiles] = useState<api.Profile[]>([]);
  // The WeCom channel derives its recipient from the owner's binding. On a
  // deployment with no WeCom app configured the field is not rendered at all —
  // the binding card its hint points at is hidden too, so a visible toggle
  // would advertise a dead end. Configured but unbound, it is disabled rather
  // than accepted and silently ignored on every run.
  const [wecom, setWecom] = useState({ available: false, bound: false });
  // Same contract for the Feishu DM channel — hidden when unconfigured,
  // disabled until bound.
  const [feishu, setFeishu] = useState({ available: false, bound: false });
  // Guards double-fires of Run-now while a run is in flight (the legacy button
  // showed a spinner and disabled itself; navigation happens on completion).
  const runningIds = useRef<Set<number>>(new Set());
  const [historyTask, setHistoryTask] = useState<Task | null>(null);

  useEffect(() => {
    void fetchWeComBinding().then((state) => setWecom({ available: state.available, bound: state.binding !== null }));
    void fetchFeishuBinding().then((state) => setFeishu({ available: state.available, bound: state.binding !== null }));
  }, []);

  useEffect(() => {
    api
      .fetchProfiles()
      // Scheduled execution currently resolves immutable system YAML profiles.
      // Custom profiles are intentionally not advertised until their ownership,
      // sharing, and deletion semantics are supported by the scheduler.
      .then((items) => setProfiles(items.filter((profile) => !profile.is_custom)))
      .catch(() => {});
  }, []);

  const dataSource = useMemo<CrudDataSource<Task>>(
    () => ({
      async list() {
        const items = await api.listTasks();
        const visible = filterAutomationsByScope(items, currentUser?.id, scope);
        return { items: visible, total: visible.length };
      },
      create: (data) => api.createTask(withFormDefaults(data) as ScheduledTaskInput),
      update: (id, data) => api.updateTask(Number(id), withFormDefaults(data)),
      remove: (id) => api.deleteTask(Number(id)),
    }),
    [currentUser?.id, scope],
  );

  const profileName = useCallback((id: string) => profiles.find((p) => p.id === id)?.name ?? id, [profiles]);

  const schema = useMemo(
    () =>
      defineCrud<Task>({
        name: 'Task',
        idField: 'id',
        dataSource,
        pageSize: 50,
        storageKey: `settings-automations:${scope}`,
        formMode: 'dialog',
        formSize: 'workspace',
        formTitle: (mode) => (mode === 'add' ? t('automations.createTitle') : t('automations.editTitle')),
        columns: [
          {
            key: 'name',
            label: t('automations.colTask'),
            type: 'custom',
            render: (task) => (
              <div className="min-w-0">
                <div className="font-medium text-fg truncate max-w-xs" title={task.name}>
                  {task.name}
                </div>
                <div className="text-xs text-fg-faint line-clamp-1 mt-0.5">{task.task_prompt}</div>
              </div>
            ),
          },
          ...(scope === 'team'
            ? [
                {
                  key: 'owner_nickname',
                  label: t('assetScopes.owner'),
                  type: 'custom' as const,
                  width: '8rem',
                  render: (task: Task) => (
                    <span className="text-xs text-fg-muted">{task.owner_nickname ?? task.user_id}</span>
                  ),
                },
              ]
            : []),
          {
            key: 'schedule',
            label: t('automations.colSchedule'),
            width: '8rem',
            type: 'custom',
            render: (task) => (
              <div className="flex items-center gap-1 text-xs text-fg-secondary" title={task.schedule}>
                <Clock size={11} />
                {task.enabled && task.next_run_at
                  ? t('automations.nextRun', { time: formatDate(task.next_run_at) })
                  : t('automations.noNextRun')}
              </div>
            ),
          },
          {
            key: 'profile_id',
            label: t('automations.colProfile'),
            width: '6rem',
            type: 'custom',
            render: (task) => <Badge variant="secondary">{profileName(task.profile_id)}</Badge>,
          },
          {
            key: 'enabled',
            label: t('automations.colStatus'),
            type: 'toggle',
            align: 'center',
            width: '4rem',
            onToggle: async (task, next) => {
              await api.updateTask(task.id, { enabled: next });
            },
          },
          { key: 'run_count', label: t('automations.colRuns'), type: 'number', align: 'right', width: '4rem' },
          {
            key: 'last_run_at',
            label: t('automations.colLastRun'),
            width: '9rem',
            type: 'custom',
            render: (task) =>
              task.last_run_at ? (
                <span className="text-xs text-fg-muted">
                  {formatDateInZone(task.last_run_at, task.timezone)}{' '}
                  {task.last_status === 'completed' ? (
                    <CheckCircle
                      size={13}
                      className="inline text-success"
                      role="img"
                      aria-label={t('common.completed')}
                    />
                  ) : task.last_status === 'failed' ? (
                    <XCircle size={13} className="inline text-danger" role="img" aria-label={t('common.failed')} />
                  ) : (
                    <Clock size={13} className="inline text-warning" role="img" aria-label={t('common.pending')} />
                  )}
                </span>
              ) : (
                <span className="text-xs text-fg-muted">—</span>
              ),
          },
        ],
        formFields: [
          {
            key: 'name',
            label: t('automations.taskName'),
            type: 'text',
            width: 1,
            required: true,
            placeholder: t('automations.taskNamePlaceholder'),
          },
          {
            key: 'profile_id',
            label: t('automations.profile'),
            type: 'custom',
            width: 1,
            defaultValue: 'team',
            render: ({ value, onChange }) => (
              <Select value={String(value ?? 'team')} onChange={(e) => onChange(e.target.value)}>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            ),
          },
          {
            key: 'timezone',
            label: t('automations.timezone'),
            type: 'text',
            width: 1,
            defaultValue: 'UTC',
            placeholder: 'UTC',
          },
          {
            key: 'max_steps',
            label: t('automations.maxSteps'),
            type: 'number',
            width: 1,
            min: 1,
            max: 20,
            defaultValue: 15,
          },
          {
            key: 'task_prompt',
            label: t('automations.taskPrompt'),
            type: 'custom',
            width: 4,
            required: true,
            render: ({ value, onChange }) => (
              <div>
                <Textarea
                  value={(value as string) ?? ''}
                  onChange={(e) => onChange(e.target.value)}
                  placeholder={t('automations.taskPromptPlaceholder')}
                  rows={10}
                  className="font-mono text-sm"
                />
                <p className="text-xs text-fg-muted mt-1">{String(value ?? '').length} / 4000</p>
              </div>
            ),
          },
          {
            key: 'schedule',
            label: t('automations.schedule'),
            type: 'custom',
            width: 4,
            required: true,
            defaultValue: '0 22 * * *',
            render: (props) => <ScheduleField {...props} />,
          },
          {
            key: 'notify_webhook',
            label: t('automations.notifyWebhook'),
            type: 'text',
            help: t('automations.notifyWebhookHint'),
            placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...',
          },
          {
            key: 'notify_email',
            label: t('automations.notifyEmail'),
            type: 'custom',
            defaultValue: false,
            help: t('automations.notifyEmailHint'),
            render: ({ value, onChange, disabled }) => (
              <Toggle checked={value === true} disabled={disabled} onChange={(next) => onChange(next)} />
            ),
          },
          ...((wecom.available
            ? [
                {
                  key: 'notify_wecom',
                  label: t('automations.notifyWeCom'),
                  type: 'custom',
                  defaultValue: false,
                  // Greyed out until the account is bound, because there is no
                  // recipient to derive otherwise — the toggle would silently do
                  // nothing on every run.
                  help: wecom.bound ? t('automations.notifyWeComHint') : undefined,
                  comment: wecom.bound ? undefined : t('automations.notifyWeComUnbound'),
                  render: ({ value, onChange, disabled }) => (
                    <Toggle
                      checked={value === true && wecom.bound}
                      disabled={disabled || !wecom.bound}
                      onChange={(next) => onChange(next)}
                    />
                  ),
                },
              ]
            : []) satisfies FieldDef<Task>[]),
          ...((feishu.available
            ? [
                {
                  key: 'notify_feishu',
                  label: t('automations.notifyFeishu'),
                  type: 'custom',
                  defaultValue: false,
                  // Greyed out until the account is bound — same reasoning as
                  // the WeCom toggle above.
                  help: feishu.bound ? t('automations.notifyFeishuHint') : undefined,
                  comment: feishu.bound ? undefined : t('automations.notifyFeishuUnbound'),
                  render: ({ value, onChange, disabled }) => (
                    <Toggle
                      checked={value === true && feishu.bound}
                      disabled={disabled || !feishu.bound}
                      onChange={(next) => onChange(next)}
                    />
                  ),
                },
              ]
            : []) satisfies FieldDef<Task>[]),
          {
            key: 'unattended_tools',
            label: t('automations.tools'),
            type: 'custom',
            width: 4,
            defaultValue: [],
            render: (props) => <OptInToolsField {...props} />,
          },
        ],
        access: {
          canAdd: scope === 'mine',
          canEdit: scope !== 'shared' && (scope === 'mine' || isSuper),
          canDelete: scope !== 'shared' && (scope === 'mine' || isSuper),
        },
        deleteConfirm: (task) => ({
          title: t('automations.deleteTaskTitle'),
          description: t('automations.deleteTaskConfirm', { name: task.name }),
        }),
        tableActions: [
          {
            key: 'history',
            label: t('automations.viewHistory'),
            icon: History,
            onClick: (task) => setHistoryTask(task),
          },
          {
            key: 'run',
            label: t('automations.runNow'),
            icon: Play,
            tone: 'primary',
            onClick: async (task) => {
              if (runningIds.current.has(task.id)) return;
              runningIds.current.add(task.id);
              try {
                const result = await api.runTask(task.id);
                window.location.hash = `#/chat?session=${encodeURIComponent(result.session_id)}`;
              } catch (err) {
                toast(err instanceof Error ? err.message : t('automations.runFailed'), 'error');
              } finally {
                runningIds.current.delete(task.id);
              }
            },
          },
        ],
        slots: {
          toolbar: (ctx) => (
            <div className="flex flex-wrap items-center gap-2">
              <FilterPills
                items={assetScopeItems(isSuper, {
                  mine: t('history.scopeMine'),
                  shared: t('history.scopeShared'),
                  team: t('history.scopeTeam'),
                })}
                activeKey={scope}
                onChange={(key) => setScope((key ?? 'mine') as AssetScope)}
                variant="segment"
                fill
                className="w-full sm:w-auto sm:min-w-80"
              />
              <div className="flex-1" />
              <span className="text-xs text-fg-muted whitespace-nowrap">
                {t('automations.countLabel', { count: ctx.total })}
              </span>
              {scope === 'mine' && (
                <Button size="sm" onClick={ctx.openCreate}>
                  <Plus size={14} className="mr-1" />
                  {t('automations.create')}
                </Button>
              )}
            </div>
          ),
          empty: (
            <EmptyState
              icon={Zap}
              title={t(`assetScopes.automationsEmpty.${scope}.title`)}
              description={t(`assetScopes.automationsEmpty.${scope}.description`)}
            />
          ),
        },
      }),
    // `wecom` arrives asynchronously; without it the schema never rebuilds
    // and the WeCom toggle stays disabled even after the binding loads.
    [t, dataSource, profiles, profileName, wecom, feishu, scope, isSuper],
  );

  return (
    <ModulePage moduleId="workspace.automations" layout="list">
      <CrudPage key={scope} schema={schema} />
      {historyTask && <RunHistoryDialog task={historyTask} onClose={() => setHistoryTask(null)} />}
    </ModulePage>
  );
}
