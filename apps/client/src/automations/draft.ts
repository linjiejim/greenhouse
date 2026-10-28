/**
 * The automation editor's form: a draft from an automation (or a new one), its inline checks and
 * the request body. React-free (./draft.test.ts).
 *
 * The station owns the rules (apps/api/src/scheduler/task-center.ts: name 2–50, instructions
 * 10–4000, the 15-minute cron floor, max steps 1–20, the webhook hosts its notification transports
 * accept); these checks only say so before a save. Delivery is sent as the structured `notify`
 * object the API prefers — never the 1.x flat `notify_*` fields — and an edit sends only what
 * changed (`notify` merges key by key; an untouched agent keeps its pinned version).
 */

import type { Automation } from './model';
import { checkSchedule, DEFAULT_CRON, type ScheduleCheck } from './cron';
import type { AutomationOptInTool } from '../shared/greenhouse-types';

/** apps/api/src/scheduler/task-limits.ts */
export const NAME_MIN = 2;
export const NAME_MAX = 50;
export const PROMPT_MIN = 10;
export const PROMPT_MAX = 4000;
export const MAX_STEPS_LIMIT = 20;
export const DEFAULT_MAX_STEPS = 15;
const WEBHOOK_MAX = 500;

export interface AutomationDraft {
  name: string;
  prompt: string;
  schedule: string;
  timezone: string;
  /** A system profile id, `custom:<id>`, or the stored pin `custom:<id>@<version>`. */
  profileId: string;
  enabled: boolean;
  /** As typed; checked as a whole number 1–20. */
  maxSteps: string;
  /** Delivery to the owner, by transport preference key (`email`, `wecom`, `feishu` …). */
  notify: Record<string, boolean>;
  /** The optional group-bot webhook; '' for none. */
  webhook: string;
  quietWhenEmpty: boolean;
  /** Extra tools granted to unattended runs. */
  tools: string[];
}

/** One delivery choice the station offers (its manifest's notification transports). */
export interface NotifyChannel {
  /** The `notify` key (the transport's `bindingSettings.preference`). */
  key: string;
  label: string;
}

/** A new automation: daily at 09:00 in the member's zone, run by the default agent, switched on. */
export function newDraft(defaults: { timezone: string; profileId: string }): AutomationDraft {
  return {
    name: '',
    prompt: '',
    schedule: DEFAULT_CRON,
    timezone: defaults.timezone,
    profileId: defaults.profileId,
    enabled: true,
    maxSteps: String(DEFAULT_MAX_STEPS),
    notify: {},
    webhook: '',
    quietWhenEmpty: false,
    tools: [],
  };
}

/** The draft an automation opens as. */
export function draftFromAutomation(task: Automation): AutomationDraft {
  const notify: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(task.notify ?? {})) if (key !== 'webhook') notify[key] = value === true;
  return {
    name: task.name,
    prompt: task.task_prompt,
    schedule: task.schedule,
    timezone: task.timezone || 'UTC',
    profileId: task.profile_id,
    enabled: task.enabled,
    maxSteps: String(task.max_steps ?? DEFAULT_MAX_STEPS),
    notify,
    webhook: typeof task.notify?.webhook === 'string' ? task.notify.webhook : '',
    quietWhenEmpty: task.quiet_when_empty === true,
    tools: [...(task.unattended_tools ?? [])],
  };
}

/** A duplicate starts from the original's settings, paused, under a new name. */
export function duplicateDraft(task: Automation, name: string): AutomationDraft {
  return { ...draftFromAutomation(task), name: name.slice(0, NAME_MAX), enabled: false };
}

export type DraftError =
  | 'nameLength'
  | 'promptShort'
  | 'promptLong'
  | 'maxSteps'
  | 'webhookInvalid'
  | Extract<ScheduleCheck, { ok: false }>['error'];

export type DraftErrors = Partial<
  Record<'name' | 'prompt' | 'schedule' | 'timezone' | 'maxSteps' | 'webhook', DraftError>
>;

const steps = (text: string) => (/^\d{1,2}$/.test(text.trim()) ? Number(text.trim()) : NaN);

/** What stops this draft from saving, by field; `check` is the schedule's verdict (./cron.ts `checkSchedule`). */
export function validateDraft(draft: AutomationDraft, check: ScheduleCheck): DraftErrors {
  const errors: DraftErrors = {};
  const name = draft.name.trim();
  if (name.length < NAME_MIN || name.length > NAME_MAX) errors.name = 'nameLength';
  const prompt = draft.prompt.trim();
  if (prompt.length < PROMPT_MIN) errors.prompt = 'promptShort';
  else if (prompt.length > PROMPT_MAX) errors.prompt = 'promptLong';
  if (!check.ok) {
    if (check.error === 'timezoneInvalid') errors.timezone = check.error;
    else errors.schedule = check.error;
  }
  const n = steps(draft.maxSteps);
  if (!(n >= 1 && n <= MAX_STEPS_LIMIT)) errors.maxSteps = 'maxSteps';
  const webhook = draft.webhook.trim();
  if (webhook) {
    let url: URL | null;
    try {
      url = new URL(webhook);
    } catch {
      url = null;
    }
    if (!url || url.protocol !== 'https:' || webhook.length > WEBHOOK_MAX) errors.webhook = 'webhookInvalid';
  }
  return errors;
}

/** The schedule verdict and field errors together, for the editor. */
export function reviewDraft(draft: AutomationDraft, now: number) {
  const schedule = checkSchedule(draft.schedule, draft.timezone, now);
  return { schedule, errors: validateDraft(draft, schedule) };
}

/** `POST /api/tasks` and `PUT /api/tasks/:id` bodies (apps/api/src/scheduler/task-center.ts `CreateTaskInput`). */
export interface AutomationBody {
  name?: string;
  task_prompt?: string;
  schedule?: string;
  timezone?: string;
  profile_id?: string;
  enabled?: boolean;
  max_steps?: number;
  notify?: Record<string, boolean | string | null>;
  quiet_when_empty?: boolean;
  unattended_tools?: string[];
}

/**
 * The request body. New: every field, `notify` holding the channels the station offers. Edit
 * (`original` given): only the fields that changed, `{}` when none did.
 */
export function automationBody(
  draft: AutomationDraft,
  options: { original?: AutomationDraft | null; channels: readonly NotifyChannel[]; webhook: boolean },
): AutomationBody {
  const value = {
    name: draft.name.trim(),
    task_prompt: draft.prompt.trim(),
    schedule: draft.schedule.trim().replace(/\s+/g, ' '),
    timezone: draft.timezone.trim(),
    profile_id: draft.profileId,
    enabled: draft.enabled,
    max_steps: steps(draft.maxSteps),
    quiet_when_empty: draft.quietWhenEmpty,
    unattended_tools: [...draft.tools],
  };
  const notify: Record<string, boolean | string | null> = {};
  for (const channel of options.channels) notify[channel.key] = draft.notify[channel.key] === true;
  if (options.webhook) notify.webhook = draft.webhook.trim() || null;

  const original = options.original;
  if (!original) return { ...value, ...(Object.keys(notify).length ? { notify } : {}) };

  const before = automationBody(original, { channels: options.channels, webhook: options.webhook });
  const body: AutomationBody = {};
  for (const key of Object.keys(value) as (keyof typeof value)[]) {
    if (JSON.stringify(value[key]) !== JSON.stringify(before[key])) Object.assign(body, { [key]: value[key] });
  }
  const changed = Object.fromEntries(Object.entries(notify).filter(([key, v]) => before.notify?.[key] !== v));
  if (Object.keys(changed).length) body.notify = changed;
  return body;
}

/** Whether the draft differs from where it started (the unsaved-changes guard). */
export function draftChanged(draft: AutomationDraft, start: AutomationDraft): boolean {
  return JSON.stringify(draft) !== JSON.stringify(start);
}

// ─── Delivery and tools the station offers ───────────────

/**
 * The delivery choices from the station manifest (`GET /api/extensions` `notificationTransports`):
 * every transport with a member preference, and whether any accepts a group-bot webhook.
 */
export function notifyOptions(value: unknown): { channels: NotifyChannel[]; webhook: boolean } {
  const list = Array.isArray(value) ? value : [];
  const channels: NotifyChannel[] = [];
  let webhook = false;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as { bindingSettings?: { preference?: unknown; label?: unknown }; webhook?: unknown };
    if (entry.webhook === true) webhook = true;
    const key = entry.bindingSettings?.preference;
    if (typeof key !== 'string' || !key || key === 'webhook' || channels.some((c) => c.key === key)) continue;
    const label = entry.bindingSettings?.label;
    channels.push({ key, label: typeof label === 'string' && label ? label : key });
  }
  return { channels, webhook };
}

/**
 * The tools this member may grant to an automation's unattended runs: the catalog (core plus the
 * station's `automationTools`) limited to the tools the member already holds (`GET /api/tools`),
 * in catalog order. A tool the member lacks is never offered: the station would ignore it.
 */
export function grantableTools(
  core: readonly AutomationOptInTool[],
  station: unknown,
  held: readonly string[],
): AutomationOptInTool[] {
  const extra = (Array.isArray(station) ? station : []).filter(
    (tool): tool is AutomationOptInTool =>
      !!tool &&
      typeof tool === 'object' &&
      typeof (tool as AutomationOptInTool).id === 'string' &&
      ((tool as AutomationOptInTool).tier === 'assist' || (tool as AutomationOptInTool).tier === 'write'),
  );
  const have = new Set(held);
  const catalog = new Map<string, AutomationOptInTool>();
  for (const tool of [...core, ...extra]) if (!catalog.has(tool.id)) catalog.set(tool.id, tool);
  return [...catalog.values()].filter((tool) => have.has(tool.id)).sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

/** A grant in catalog order: the station stores it that way, so an untouched list compares equal. */
export function orderedTools(ids: readonly string[], catalog: readonly AutomationOptInTool[]): string[] {
  const picked = new Set(ids);
  const known = catalog.filter((tool) => picked.has(tool.id)).map((tool) => tool.id);
  // ids the catalog no longer lists stay where they were (the station drops them on read)
  return [...known, ...ids.filter((id) => !known.includes(id))];
}

// ─── Agents an automation may run as ─────────────────────

export interface ProfileChoice {
  id: string;
  name: string;
  is_custom?: boolean;
  user_id?: string;
  is_shared?: boolean;
}

/** `custom:5@3` → `custom:5`; any other id unchanged. */
export function unpinnedProfileId(id: string): string {
  return id.startsWith('custom:') ? id.replace(/@\d+$/, '') : id;
}

/** The version a stored `custom:<id>@<v>` is pinned to, or null. */
export function pinnedProfileVersion(id: string): number | null {
  const match = /^custom:[^@]+@(\d+)$/.exec(id);
  return match ? Number(match[1]) : null;
}

/**
 * Whom an automation of mine may run as: the built-in agents, then my own and the team's custom
 * agents (`GET /api/profiles`). The station pins a picked custom agent to its current version and
 * checks it again on save and on every run.
 */
export function agentChoices<T extends ProfileChoice>(
  profiles: readonly T[],
  userId: string | null | undefined,
): { builtIn: T[]; custom: T[] } {
  return {
    builtIn: profiles.filter((profile) => !profile.is_custom),
    custom: profiles.filter(
      (profile) => profile.is_custom && (profile.user_id === userId || profile.is_shared === true),
    ),
  };
}
