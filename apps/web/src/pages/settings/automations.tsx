/**
 * Automations panel — scheduled tasks, driven by one @greenhouse/crud schema.
 *
 * The list (table + toolbar + delete), the add/edit Dialog, enable/disable, and
 * the Run-now / History row actions all come from `defineCrud`. The only bespoke
 * piece is the friendly cron builder, embedded as a `custom` form field.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { defineCrud, CrudPage, type CrudDataSource, type CrudFieldRenderProps } from '@greenhouse/crud';
import { Input, Select, Badge, StatusDot, toast } from '../../components/ui';
import { Play, Clock, History, Zap } from '../../lib/icons';
import * as api from '../../lib/api';
import type { ScheduledTask, ScheduledTaskInput } from '../../lib/api';
import { useT } from '../../lib/i18n';

type Task = ScheduledTask & { schedule_desc?: string };

// ─── Schedule builder ────────────────────────────────────
//
// Friendly schedule editor: frequency + time (+ weekdays / day of month) that
// compiles to a standard 5-field cron expression. Expressions that don't fit
// these shapes fall back to raw cron. Embedded as a `custom` CRUD field below.

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
          <div className="flex items-center gap-4">
            {sched.freq === 'monthly' && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-fg-secondary whitespace-nowrap">{t('automations.monthDayLabel')}</span>
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
  );
}

// ─── Panel ───────────────────────────────────────────────

export function AutomationsPanel() {
  const t = useT();
  const [profiles, setProfiles] = useState<api.Profile[]>([]);

  useEffect(() => {
    api
      .fetchProfiles()
      .then(setProfiles)
      .catch(() => {});
  }, []);

  const dataSource = useMemo<CrudDataSource<Task>>(
    () => ({
      async list() {
        const items = await api.listTasks();
        return { items, total: items.length };
      },
      async get(id) {
        const found = (await api.listTasks()).find((task) => String(task.id) === id);
        if (!found) throw new Error('Task not found');
        return found;
      },
      create: (data) => api.createTask(data as unknown as ScheduledTaskInput),
      update: (id, data) => api.updateTask(Number(id), data as Partial<ScheduledTaskInput> & { enabled?: boolean }),
      remove: (id) => api.deleteTask(Number(id)),
    }),
    [],
  );

  const profileName = useCallback((id: string) => profiles.find((p) => p.id === id)?.name ?? id, [profiles]);

  const schema = useMemo(
    () =>
      defineCrud<Task>({
        name: t('automations.colTask'),
        icon: Zap,
        idField: 'id',
        dataSource,
        emptyMessage: t('automations.noneTitle'),
        formMode: 'dialog',
        formTitle: (mode) => (mode === 'add' ? t('automations.createTitle') : t('automations.editTitle')),
        columns: [
          {
            key: 'name',
            label: t('automations.colTask'),
            type: 'custom',
            render: (row) => (
              <div className="min-w-0">
                <div className="font-medium text-fg truncate max-w-xs" title={row.name}>
                  {row.name}
                </div>
                <div className="text-xs text-fg-faint line-clamp-1 mt-0.5">{row.task_prompt}</div>
              </div>
            ),
          },
          {
            key: 'schedule',
            label: t('automations.colSchedule'),
            width: '160px',
            type: 'custom',
            render: (row) => (
              <div className="flex items-center gap-1 text-xs text-fg-secondary">
                <Clock size={11} />
                {row.schedule_desc || row.schedule}
              </div>
            ),
          },
          {
            key: 'profile_id',
            label: t('automations.colProfile'),
            width: '120px',
            type: 'custom',
            render: (row) => <Badge variant="secondary">{profileName(row.profile_id)}</Badge>,
          },
          {
            key: 'enabled',
            label: t('automations.colStatus'),
            type: 'toggle',
            align: 'center',
            width: '80px',
            onToggle: async (row, next) => {
              await api.updateTask(row.id, { enabled: next });
            },
          },
          { key: 'run_count', label: t('automations.colRuns'), type: 'number', align: 'right', width: '70px' },
          {
            key: 'last_run_at',
            label: t('automations.colLastRun'),
            width: '150px',
            type: 'custom',
            render: (row) =>
              row.last_run_at ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
                  <StatusDot
                    color={
                      row.last_status === 'completed' ? 'success' : row.last_status === 'failed' ? 'danger' : 'muted'
                    }
                    size="sm"
                  />
                  {new Date(row.last_run_at).toLocaleString('zh-CN', { timeZone: row.timezone })}
                </span>
              ) : (
                <span className="text-fg-faint">—</span>
              ),
          },
        ],
        formFields: [
          {
            key: 'name',
            label: t('automations.taskName'),
            type: 'text',
            required: true,
            placeholder: t('automations.taskNamePlaceholder'),
          },
          {
            key: 'profile_id',
            label: t('automations.profile'),
            type: 'select',
            defaultValue: 'default',
            comment: t('automations.profileHint'),
            options: profiles.map((p) => ({ value: p.id, label: p.name })),
          },
          {
            key: 'task_prompt',
            label: t('automations.taskPrompt'),
            type: 'textarea',
            required: true,
            rows: 5,
            placeholder: t('automations.taskPromptPlaceholder'),
          },
          {
            key: 'schedule',
            label: t('automations.schedule'),
            type: 'custom',
            required: true,
            defaultValue: '0 22 * * *',
            render: (props) => <ScheduleField {...props} />,
          },
          { type: 'divider', label: t('automations.advancedSettings') },
          {
            key: 'max_steps',
            label: t('automations.maxSteps'),
            type: 'number',
            width: 2,
            min: 1,
            max: 20,
            defaultValue: 15,
          },
          {
            key: 'timezone',
            label: t('automations.timezone'),
            type: 'text',
            width: 2,
            defaultValue: 'UTC',
            placeholder: 'UTC',
          },
        ],
        access: { canAdd: true, canEdit: true, canDelete: true },
        tableActions: [
          {
            key: 'run',
            label: t('automations.runNow'),
            icon: Play,
            tone: 'primary',
            onClick: async (row) => {
              try {
                const result = await api.runTask(row.id);
                window.location.hash = `#/chat/${result.session_id}`;
              } catch (err) {
                toast(err instanceof Error ? err.message : t('automations.runFailed'), 'error');
              }
            },
          },
          {
            key: 'history',
            label: t('automations.viewHistory'),
            icon: History,
            onClick: (row) => {
              window.location.hash = `#/history?task=${row.id}`;
            },
          },
        ],
      }),
    [t, dataSource, profiles, profileName],
  );

  return <CrudPage schema={schema} />;
}
