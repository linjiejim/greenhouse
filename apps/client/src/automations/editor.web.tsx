/**
 * The automation editor (wide browser): a fixed-size dialog that creates, edits or duplicates one
 * of my automations — name, instructions, the schedule (presets or a cron, in words with its next
 * runs), time zone, the agent it runs as, where results go, and the unattended-run settings.
 * Rules and the request body are React-free (./draft.ts, ./cron.ts); the station validates again
 * on save (apps/api/src/scheduler/task-center.ts) and its words show inline when it refuses.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createAutomation, updateAutomation } from '../api/automations';
import { listProfiles, listMyTools, profileName, type AgentProfile } from '../api/profiles';
import { captureIdentity } from '../data/identity';
import { useLocale, useT, type TranslationKey } from '../lib/i18n';
import { useStationManifest } from '../plugins/store';
import { CORE_OPT_IN_TOOLS, type AutomationOptInTool } from '../shared/greenhouse-types';
import { useAuth } from '../store/auth';
import { usePrefs } from '../store/prefs';
import { Icon } from '../ui/core';
import { confirmDiscard } from '../ui/form-guard';
import { toast } from '../ui/toast';
import { buildCron, FREQUENCIES, parseCron, withFrequency, type ScheduleState } from './cron';
import {
  agentChoices,
  automationBody,
  draftChanged,
  draftFromAutomation,
  duplicateDraft,
  grantableTools,
  NAME_MAX,
  newDraft,
  notifyOptions,
  orderedTools,
  pinnedProfileVersion,
  PROMPT_MAX,
  reviewDraft,
  unpinnedProfileId,
  type AutomationDraft,
  type DraftErrors,
  type NotifyChannel,
} from './draft';
import { Check, EditorDialog, Field, focusFirstInvalid, useTouched } from './form-parts.web';
import type { Automation } from './model';
import { describeSchedule, zonePlace } from './schedule';
import { runLabel, timeZoneIds, zoneLabel } from './zones';

export type AutomationEditorMode =
  | { kind: 'new' }
  | { kind: 'edit'; task: Automation }
  | { kind: 'duplicate'; task: Automation };

const DEVICE_ZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

/** Monday first, as the week reads. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

export function AutomationEditor({
  mode,
  onClose,
  onSaved,
  onManageAgents,
}: {
  mode: AutomationEditorMode;
  onClose: () => void;
  onSaved: (task: Automation) => void;
  /** Leave for the Agents section (asked only once nothing would be lost). */
  onManageAgents?: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const lang = usePrefs((s) => s.lang);
  const userId = useAuth((s) => s.user?.id);
  const manifest = useStationManifest((s) => s.data);
  const original = mode.kind === 'edit' ? mode.task : null;

  const [profiles, setProfiles] = useState<AgentProfile[] | null>(null);
  const [heldTools, setHeldTools] = useState<string[] | null>(null);
  useEffect(() => {
    const current = captureIdentity();
    let alive = true;
    void listProfiles().then((r) => alive && current() && setProfiles(r.ok ? r.data : []));
    void listMyTools().then((r) => alive && current() && setHeldTools(r.ok ? r.data.map((tool) => tool.id) : []));
    return () => {
      alive = false;
    };
  }, []);

  const [start] = useState<AutomationDraft>(() =>
    mode.kind === 'edit'
      ? draftFromAutomation(mode.task)
      : mode.kind === 'duplicate'
        ? duplicateDraft(mode.task, t('automations.copyName', { name: mode.task.name }))
        : newDraft({ timezone: DEVICE_ZONE, profileId: 'sprouty' }),
  );
  const [draft, setDraft] = useState(start);
  const [builder, setBuilder] = useState<ScheduleState>(() => parseCron(start.schedule));
  const [now] = useState(Date.now);
  const [submitted, setSubmitted] = useState(false);
  const [touched, touch] = useTouched();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const set = (patch: Partial<AutomationDraft>) => {
    setSaveError('');
    setDraft((d) => ({ ...d, ...patch }));
  };
  const setSchedule = (next: ScheduleState) => {
    setBuilder(next);
    set({ schedule: buildCron(next) });
  };
  const leave = (field: keyof AutomationDraft) => touch(field, draft[field] !== start[field]);

  // What the station offers: delivery from its manifest (a 3.x station has none, so an edit keeps
  // the channels the automation already stores), grantable tools from the catalog and my tools.
  const { channels, webhook } = useMemo(() => {
    if (manifest.kind === 'v2') return notifyOptions(manifest.manifest.notificationTransports);
    const stored = Object.keys(original?.notify ?? {}).filter((key) => key !== 'webhook');
    return {
      channels: stored.map((key) => ({ key, label: key })),
      webhook: !!original?.notify && 'webhook' in original.notify,
    };
  }, [manifest, original]);
  // `automationTools` rides beside the typed manifest (apps/api/src/routes/extensions.ts)
  const stationTools =
    manifest.kind === 'v2'
      ? (manifest.manifest as unknown as { automationTools?: unknown }).automationTools
      : undefined;
  const offeredTools = useMemo(
    () => grantableTools(CORE_OPT_IN_TOOLS, stationTools, heldTools ?? []),
    [stationTools, heldTools],
  );

  const { schedule: check, errors } = useMemo(() => reviewDraft(draft, now), [draft, now]);
  const shown = (field: keyof DraftErrors) =>
    errors[field] && (submitted || touched.has(field) || field === 'schedule' || field === 'timezone')
      ? t(`automations.editor.error.${errors[field]}` as TranslationKey)
      : null;
  const dirty = draftChanged(draft, start);

  const save = async () => {
    if (saving) return;
    setSubmitted(true);
    if (Object.keys(errors).length) {
      requestAnimationFrame(() => focusFirstInvalid());
      return;
    }
    const body = automationBody(draft, { original: original ? start : null, channels, webhook });
    if (original && !Object.keys(body).length) {
      onClose();
      return;
    }
    const current = captureIdentity();
    setSaving(true);
    const r = original ? await updateAutomation(original.id, body) : await createAutomation(body);
    if (!alive.current || !current()) return;
    setSaving(false);
    if (!r.ok) {
      setSaveError(r.message || t('automations.editor.saveFailed'));
      return;
    }
    toast(original ? t('automations.saved') : t('automations.created'));
    onSaved(r.data.task);
  };

  const title = t(
    mode.kind === 'edit'
      ? 'automations.editor.editTitle'
      : mode.kind === 'duplicate'
        ? 'automations.editor.duplicateTitle'
        : 'automations.editor.newTitle',
  );
  const lead = saveError ? (
    <span role="alert" className="gh-auto-error" title={saveError}>
      {saveError}
    </span>
  ) : submitted && Object.keys(errors).length ? (
    <span role="alert" className="gh-auto-error">
      {t('automations.editor.fixErrors')}
    </span>
  ) : (
    <label>
      <input
        type="checkbox"
        role="switch"
        className="gh-auto-switch"
        checked={draft.enabled}
        aria-checked={draft.enabled}
        onChange={(e) => set({ enabled: e.target.checked })}
      />
      {t('automations.editor.enabled')}
    </label>
  );

  return (
    <EditorDialog
      title={title}
      testID="automation-editor"
      dirty={dirty}
      busy={saving}
      saveLabel={t(original ? 'automations.editor.save' : 'automations.editor.create')}
      onClose={onClose}
      onSave={() => void save()}
      lead={lead}
      focus={nameRef}
    >
      <Field label={t('automations.editor.name')} error={shown('name')}>
        {({ id, describedBy, invalid }) => (
          <input
            ref={nameRef}
            id={id}
            className="gh-auto-input"
            value={draft.name}
            maxLength={NAME_MAX + 10}
            placeholder={t('automations.editor.namePlaceholder')}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            onChange={(e) => set({ name: e.target.value })}
            onBlur={() => leave('name')}
          />
        )}
      </Field>
      <Field
        label={t('automations.editor.prompt')}
        count={t('automations.editor.count', { n: draft.prompt.trim().length, max: PROMPT_MAX })}
        over={draft.prompt.trim().length > PROMPT_MAX}
        error={shown('prompt')}
      >
        {({ id, describedBy, invalid }) => (
          <textarea
            id={id}
            className="gh-auto-textarea"
            rows={6}
            value={draft.prompt}
            placeholder={t('automations.editor.promptPlaceholder')}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            onChange={(e) => set({ prompt: e.target.value })}
            onBlur={() => leave('prompt')}
          />
        )}
      </Field>

      <ScheduleSection
        builder={builder}
        cron={draft.schedule}
        timeZone={draft.timezone}
        check={check}
        error={shown('schedule')}
        locale={locale}
        onChange={setSchedule}
      />

      <div className="gh-auto-row">
        <Field label={t('automations.editor.timezone')} error={shown('timezone')}>
          {({ id, describedBy, invalid }) => (
            <TimeZoneSelect
              id={id}
              value={draft.timezone}
              invalid={invalid}
              describedBy={describedBy}
              now={now}
              onChange={(timezone) => set({ timezone })}
            />
          )}
        </Field>
        <Field
          label={t('automations.editor.runsAs')}
          hint={profiles && !agentKnown(profiles, draft.profileId) ? t('automations.runsAsGone') : undefined}
        >
          {({ id, describedBy }) => (
            <div className="gh-auto-agent">
              <AgentSelect
                id={id}
                describedBy={describedBy}
                value={draft.profileId}
                profiles={profiles}
                userId={userId}
                lang={lang}
                onChange={(profileId) => set({ profileId })}
              />
              {onManageAgents ? (
                <button
                  type="button"
                  className="gh-auto-btn-quiet"
                  onClick={async () => {
                    if (dirty && !(await confirmDiscard(t))) return;
                    onManageAgents();
                  }}
                >
                  {t('automations.editor.manageAgents')}
                </button>
              ) : null}
            </div>
          )}
        </Field>
      </div>

      <DeliverySection
        channels={channels}
        webhook={webhook}
        draft={draft}
        webhookError={shown('webhook')}
        onChange={set}
        onBlurWebhook={() => leave('webhook')}
      />

      <fieldset className="gh-auto-section">
        <legend>{t('automations.editor.advanced')}</legend>
        <Field
          label={t('automations.editor.maxSteps')}
          hint={t('automations.editor.maxStepsHint')}
          error={shown('maxSteps')}
        >
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              className="gh-auto-input"
              data-narrow=""
              type="number"
              min={1}
              max={20}
              inputMode="numeric"
              value={draft.maxSteps}
              aria-invalid={invalid}
              aria-describedby={describedBy}
              onChange={(e) => set({ maxSteps: e.target.value })}
              onBlur={() => leave('maxSteps')}
            />
          )}
        </Field>
        <ToolGrant
          offered={offeredTools}
          loading={heldTools === null}
          selected={draft.tools}
          onChange={(tools) => set({ tools: orderedTools(tools, offeredTools) })}
        />
      </fieldset>
    </EditorDialog>
  );
}

function agentKnown(profiles: readonly AgentProfile[], value: string): boolean {
  return profiles.some((profile) => profile.id === unpinnedProfileId(value));
}

// ─── Schedule ────────────────────────────────────────────

function ScheduleSection({
  builder,
  cron,
  timeZone,
  check,
  error,
  locale,
  onChange,
}: {
  builder: ScheduleState;
  cron: string;
  timeZone: string;
  check: ReturnType<typeof reviewDraft>['schedule'];
  error: string | null;
  locale: string;
  onChange: (next: ScheduleState) => void;
}) {
  const t = useT();
  const dayNames = t('automations.schedule.dayNames').split(',');
  const words = describeSchedule(cron, {
    daily: t('automations.schedule.daily'),
    weekdays: t('automations.schedule.weekdays'),
    weekends: t('automations.schedule.weekends'),
    weekly: t('automations.schedule.weekly'),
    monthly: t('automations.schedule.monthly'),
    hourly: t('automations.schedule.hourly'),
    everyHours: t('automations.schedule.everyHours'),
    dayNames,
    listSep: t('automations.schedule.listSep'),
  });
  const place = zonePlace(timeZone, DEVICE_ZONE);
  const patch = (p: Partial<ScheduleState>) => onChange({ ...builder, ...p });
  const choose = (freq: ScheduleState['freq']) => onChange(withFrequency(builder, freq));
  const timeField = (
    <Field label={t('automations.editor.time')}>
      {({ id }) => (
        <input
          id={id}
          className="gh-auto-input"
          type="time"
          data-narrow=""
          value={builder.time}
          onChange={(e) => e.target.value && patch({ time: e.target.value })}
        />
      )}
    </Field>
  );
  return (
    <fieldset className="gh-auto-section" data-testid="automation-schedule">
      <legend>{t('automations.editor.schedule')}</legend>
      <div
        className="gh-auto-segments"
        role="radiogroup"
        aria-label={t('automations.editor.frequency')}
        onKeyDown={(e) => {
          if (!['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
          e.preventDefault();
          const group = e.currentTarget;
          const i = FREQUENCIES.indexOf(builder.freq);
          const next = FREQUENCIES[(i + (e.key === 'ArrowRight' ? 1 : -1) + FREQUENCIES.length) % FREQUENCIES.length]!;
          choose(next);
          requestAnimationFrame(() => group.querySelector<HTMLElement>(`[data-freq="${next}"]`)?.focus());
        }}
      >
        {FREQUENCIES.map((freq) => (
          <button
            key={freq}
            type="button"
            role="radio"
            data-freq={freq}
            aria-checked={builder.freq === freq}
            tabIndex={builder.freq === freq ? 0 : -1}
            onClick={() => choose(freq)}
          >
            {t(`automations.editor.freq.${freq}`)}
          </button>
        ))}
      </div>
      {builder.freq === 'custom' ? (
        <Field label={t('automations.editor.cron')} hint={t('automations.editor.cronHint')}>
          {({ id, describedBy }) => (
            <input
              id={id}
              className="gh-auto-input gh-auto-mono"
              value={builder.raw}
              placeholder="0 9 * * 1-5"
              spellCheck={false}
              aria-invalid={!!error}
              aria-describedby={describedBy}
              onChange={(e) => patch({ raw: e.target.value })}
            />
          )}
        </Field>
      ) : (
        <div className="gh-auto-inline">
          {builder.freq === 'hourly' ? (
            <Field label={t('automations.editor.minute')}>
              {({ id }) => (
                <input
                  id={id}
                  className="gh-auto-input"
                  type="number"
                  min={0}
                  max={59}
                  data-narrow=""
                  value={builder.minute}
                  onChange={(e) => patch({ minute: Number(e.target.value) })}
                />
              )}
            </Field>
          ) : null}
          {builder.freq === 'weekly' ? (
            <div className="gh-auto-field">
              <span className="gh-auto-label">{t('automations.editor.days')}</span>
              <div className="gh-auto-days" role="group" aria-label={t('automations.editor.days')}>
                {WEEK.map((day) => {
                  const on = builder.weekdays.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        patch({ weekdays: on ? builder.weekdays.filter((d) => d !== day) : [...builder.weekdays, day] })
                      }
                    >
                      {dayNames[day]}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          {builder.freq === 'monthly' ? (
            <Field label={t('automations.editor.monthDay')}>
              {({ id }) => (
                <select
                  id={id}
                  className="gh-auto-select"
                  data-narrow=""
                  value={builder.monthDay}
                  onChange={(e) => patch({ monthDay: Number(e.target.value) })}
                >
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                    <option key={day} value={day}>
                      {t('automations.editor.monthDayOption', { day })}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : null}
          {builder.freq !== 'hourly' ? timeField : null}
        </div>
      )}
      <div className="gh-auto-preview" data-error={error ? '' : undefined} aria-live="polite">
        {error ? (
          <p className="gh-auto-error" role="alert">
            {error}
          </p>
        ) : (
          <>
            <strong>
              {words}
              {place ? ` · ${t('automations.editor.inZone', { zone: place })}` : ''}
              <code>{cron}</code>
            </strong>
            {check.ok && check.runs ? (
              <ol aria-label={t('automations.editor.nextRuns')}>
                {check.runs.map((ms) => (
                  <li key={ms}>{runLabel(ms, timeZone, locale)}</li>
                ))}
              </ol>
            ) : (
              <p className="gh-auto-hint">{t('automations.editor.noPreview')}</p>
            )}
          </>
        )}
        {builder.freq === 'monthly' && builder.monthDay > 28 && !error ? (
          <p className="gh-auto-hint">{t('automations.editor.monthDaySkips', { day: builder.monthDay })}</p>
        ) : null}
      </div>
    </fieldset>
  );
}

function TimeZoneSelect({
  id,
  value,
  invalid,
  describedBy,
  now,
  onChange,
}: {
  id: string;
  value: string;
  invalid: boolean;
  describedBy?: string;
  now: number;
  onChange: (zone: string) => void;
}) {
  // built once per dialog (a few hundred zones with their offsets); the stored zone is among them
  const [zones] = useState(() => timeZoneIds(value, DEVICE_ZONE).map((zone) => [zone, zoneLabel(zone, now)] as const));
  return (
    <select
      id={id}
      className="gh-auto-select"
      value={value}
      aria-invalid={invalid}
      aria-describedby={describedBy}
      onChange={(e) => onChange(e.target.value)}
    >
      {zones.map(([zone, label]) => (
        <option key={zone} value={zone}>
          {label}
        </option>
      ))}
    </select>
  );
}

function AgentSelect({
  id,
  describedBy,
  value,
  profiles,
  userId,
  lang,
  onChange,
}: {
  id: string;
  describedBy?: string;
  value: string;
  profiles: AgentProfile[] | null;
  userId: string | undefined;
  lang: string;
  onChange: (id: string) => void;
}) {
  const t = useT();
  const { builtIn, custom } = agentChoices(profiles ?? [], userId);
  const version = pinnedProfileVersion(value);
  const pinnedAgent = version !== null ? (profiles ?? []).find((p) => p.id === unpinnedProfileId(value)) : undefined;
  // a stored pin, or an id no longer listed, stays visible until another is chosen
  const listed = [...builtIn, ...custom].some((profile) => profile.id === value);
  return (
    <select
      id={id}
      className="gh-auto-select"
      value={value}
      aria-describedby={describedBy}
      onChange={(e) => onChange(e.target.value)}
    >
      {!listed ? (
        <option value={value}>
          {pinnedAgent
            ? t('automations.editor.pinned', { name: profileName(pinnedAgent, lang), version: version ?? 1 })
            : profiles
              ? value
              : t('common.loading')}
        </option>
      ) : null}
      {builtIn.length ? (
        <optgroup label={t('automations.editor.builtIn')}>
          {builtIn.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profileName(profile, lang)}
            </option>
          ))}
        </optgroup>
      ) : null}
      {custom.length ? (
        <optgroup label={t('automations.editor.customAgents')}>
          {custom.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profileName(profile, lang)}
            </option>
          ))}
        </optgroup>
      ) : null}
    </select>
  );
}

// ─── Delivery and tools ──────────────────────────────────

function channelLabel(t: ReturnType<typeof useT>, channel: NotifyChannel): string {
  const key = `automations.channel.${channel.key}` as TranslationKey;
  const known = t(key);
  return known === key ? channel.label : known;
}

function DeliverySection({
  channels,
  webhook,
  draft,
  webhookError,
  onChange,
  onBlurWebhook,
}: {
  channels: readonly NotifyChannel[];
  webhook: boolean;
  draft: AutomationDraft;
  webhookError: string | null;
  onChange: (patch: Partial<AutomationDraft>) => void;
  onBlurWebhook: () => void;
}) {
  const t = useT();
  return (
    <fieldset className="gh-auto-section">
      <legend>{t('automations.editor.delivery')}</legend>
      <p className="gh-auto-hint">
        {channels.length || webhook ? t('automations.editor.deliveryHint') : t('automations.editor.deliveryNone')}
      </p>
      {channels.length ? (
        <div className="gh-auto-checks">
          {channels.map((channel) => (
            <Check
              key={channel.key}
              label={channelLabel(t, channel)}
              checked={draft.notify[channel.key] === true}
              onChange={(on) => onChange({ notify: { ...draft.notify, [channel.key]: on } })}
            />
          ))}
        </div>
      ) : null}
      {webhook ? (
        <Field label={t('automations.editor.webhook')} hint={t('automations.editor.webhookHint')} error={webhookError}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              className="gh-auto-input gh-auto-mono"
              type="url"
              value={draft.webhook}
              placeholder="https://…"
              spellCheck={false}
              aria-invalid={invalid}
              aria-describedby={describedBy}
              onChange={(e) => onChange({ webhook: e.target.value })}
              onBlur={onBlurWebhook}
            />
          )}
        </Field>
      ) : null}
      <Check
        asSwitch
        label={t('automations.editor.quiet')}
        hint={t('automations.editor.quietHint')}
        checked={draft.quietWhenEmpty}
        onChange={(quietWhenEmpty) => onChange({ quietWhenEmpty })}
      />
    </fieldset>
  );
}

function toolLabel(t: ReturnType<typeof useT>, id: string): string {
  const key = `automations.editor.tool.${id}` as TranslationKey;
  const known = t(key);
  return known === key ? id : known;
}

function ToolGrant({
  offered,
  loading,
  selected,
  onChange,
}: {
  offered: readonly AutomationOptInTool[];
  loading: boolean;
  selected: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  const t = useT();
  const picked = new Set(selected);
  const writes = offered.some((tool) => tool.tier === 'write' && picked.has(tool.id));
  return (
    <div className="gh-auto-field">
      <span className="gh-auto-label">{t('automations.editor.tools')}</span>
      <p className="gh-auto-hint">{t('automations.editor.toolsHint')}</p>
      {loading ? (
        <p className="gh-auto-hint">{t('common.loading')}</p>
      ) : !offered.length ? (
        <p className="gh-auto-note">{t('automations.editor.toolsNone')}</p>
      ) : (
        (['assist', 'write'] as const).map((tier) => {
          const group = offered.filter((tool) => tool.tier === tier);
          return group.length ? (
            <div
              key={tier}
              role="group"
              aria-label={t(tier === 'write' ? 'automations.editor.tierWrite' : 'automations.editor.tierAssist')}
            >
              <span className="gh-auto-hint">
                {t(tier === 'write' ? 'automations.editor.tierWrite' : 'automations.editor.tierAssist')}
              </span>
              <div className="gh-auto-checks" data-wide="">
                {group.map((tool) => (
                  <Check
                    key={tool.id}
                    label={toolLabel(t, tool.id)}
                    checked={picked.has(tool.id)}
                    onChange={(on) => onChange(on ? [...selected, tool.id] : selected.filter((id) => id !== tool.id))}
                  />
                ))}
              </div>
            </div>
          ) : null;
        })
      )}
      {writes ? (
        <p className="gh-auto-callout" role="note">
          <Icon name="alert" size={14} />
          <span>{t('automations.editor.toolsWriteWarning')}</span>
        </p>
      ) : null}
    </div>
  );
}
