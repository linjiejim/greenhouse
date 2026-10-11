/**
 * ScheduleBuilder — the one visual schedule editor: frequency + time (+ weekdays
 * / day of month), compiled to a 5-field cron by `lib/cron.ts`; raw cron is the
 * advanced escape hatch. Used by the scheduled-task form (`pages/automations.tsx`)
 * and Tables automation rules.
 *
 * Controlled by the cron string. The builder keeps its own state so a half-typed
 * raw expression is not re-parsed under the cursor; it reports every change.
 */

import { useEffect, useState } from 'react';
import { Button, FilterPills, Input, Select } from './ui';
import { useT } from '../lib/i18n';
import {
  buildCron,
  describeSchedule,
  parseCron,
  SCHEDULE_FREQUENCIES,
  WEEKDAY_LABEL_KEYS,
  type ScheduleFrequency,
  type ScheduleState,
} from '../lib/cron';

/** Monday first on screen; cron numbers Sunday 0. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function ScheduleBuilder({
  value,
  onChange,
  defaultCron = '0 9 * * *',
}: {
  value: string | null | undefined;
  onChange: (cron: string) => void;
  defaultCron?: string;
}) {
  const t = useT();
  const [state, setState] = useState<ScheduleState>(() => parseCron(value || defaultCron));
  const cron = buildCron(state);

  // Keep the owner's value in sync with the builder (initial + every change).
  useEffect(() => {
    if (cron !== value) onChange(cron);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cron]);

  const patch = (next: Partial<ScheduleState>) => setState((current) => ({ ...current, ...next }));

  return (
    <div className="space-y-3">
      <div role="group" aria-label={t('automations.freqGroupLabel')}>
        <FilterPills
          variant="segment"
          wrap
          items={SCHEDULE_FREQUENCIES.map((option) => ({ key: option.value, label: t(option.labelKey) }))}
          activeKey={state.freq}
          onChange={(key) => {
            if (!key) return;
            patch({ freq: key as ScheduleFrequency, raw: key === 'cron' ? cron : state.raw });
          }}
          className="w-fit"
        />
      </div>
      {state.freq === 'cron' ? (
        <div>
          <Input
            value={state.raw}
            onChange={(event) => patch({ raw: event.target.value })}
            placeholder="0 22 * * *"
            className="font-mono"
            aria-label={t('automations.freqCron')}
          />
          <p className="mt-1 text-xs text-fg-muted">{t('automations.cronHint')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {state.freq === 'weekly' && (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('automations.weekdayGroupLabel')}>
              {WEEKDAY_ORDER.map((day) => {
                const active = state.weekdays.includes(day);
                return (
                  <Button
                    key={day}
                    type="button"
                    size="sm"
                    variant={active ? 'secondary' : 'outline'}
                    aria-pressed={active}
                    onClick={() =>
                      patch({ weekdays: active ? state.weekdays.filter((d) => d !== day) : [...state.weekdays, day] })
                    }
                  >
                    {t(WEEKDAY_LABEL_KEYS[day]!)}
                  </Button>
                );
              })}
            </div>
          )}
          <div className="flex flex-wrap items-start gap-4">
            {state.freq === 'monthly' && (
              <label className="space-y-1">
                <span className="block text-xs font-medium text-fg-secondary">{t('automations.monthDayLabel')}</span>
                <Select
                  value={String(state.monthDay)}
                  onChange={(event) => patch({ monthDay: parseInt(event.target.value, 10) })}
                  className="w-24"
                >
                  {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                    <option key={day} value={day}>
                      {t('automations.monthDayOption', { day })}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            <label className="space-y-1">
              <span className="block text-xs font-medium text-fg-secondary">{t('automations.timeLabel')}</span>
              <Input
                type="time"
                value={state.time}
                onChange={(event) => event.target.value && patch({ time: event.target.value })}
                className="w-32"
              />
            </label>
          </div>
          <p className="text-xs text-fg-muted">
            {describeSchedule(state, t)}
            <span className="ml-2 font-mono text-fg-faint">{cron}</span>
          </p>
        </div>
      )}
    </div>
  );
}
