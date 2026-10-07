/**
 * The Bot form's rules, React-free so the root vitest can run them
 * (./use-bot-form.test.ts); ./use-bot-form.ts binds them to the store, the API
 * and the sheet (spec docs/specs/20261008-mobile-bots.md §2.5.7). One form,
 * three jobs — the same fields and name rules for each, as on the web
 * (bot-form.tsx, shared by "New Bot", the profile editor and the in-chat card):
 *
 *  - create: from a gallery template (its copy in the app language, its plant)
 *    or custom (empty, a plant none of the member's Bots wears yet);
 *  - edit: the Bot's current values; a save sends only what changed (each
 *    PATCH appends a version);
 *  - proposal: a `bot_create` card's payload, edited before accepting
 *    (`approve` + `bot`). A proposal has no "purpose" field to send.
 *
 * Model / tools / step cap are web-only (spec §1.3): never shown, never sent.
 */

import type { TranslationKey } from '../../lib/i18n';
import {
  BOT_DESCRIPTION_MAX,
  BOT_INSTRUCTIONS_MAX,
  BOT_ROLE_MAX,
  botTemplate,
  galleryTemplate,
  type BotCreatePayload,
  type BotRequestDecision,
  type BotRequestView,
  type BotTemplate,
  type BotView,
  type ComputerRuntimeView,
} from '../../shared/bots';
import type { BotWriteInput } from '../../shared/bots-wire';
import type { AvatarConfig } from '../../ui/plant-avatar/avatar-config';
import { TEMPLATE_PLANT, withPlant, type PlantId } from '../../ui/plant-avatar/plant-ids';
import { botNameIssueFromCode, type BotNameIssue } from '../vendor/bot-name';
import { botPlant, freshPlant } from './plant-pick';

export interface BotFormValues {
  name: string;
  role: string;
  /** "Purpose" — one line on what the Bot is for (create / edit only). */
  description: string;
  instructions: string;
  avatar: AvatarConfig;
}

export type BotFormMode = 'create' | 'edit' | 'proposal';

/** Everything the form needs, resolved before its (uncontrolled) fields mount. */
export interface BotFormInit {
  mode: BotFormMode;
  values: BotFormValues;
  /** The template a new Bot starts from, or the one a proposal names — the avatar preview resolves with it. */
  templateKey: string | null;
  /** The Bot being edited. */
  bot: BotView | null;
  /** The `bot_create` card being edited. */
  request: BotRequestView | null;
  /** Join this conversation once created (Invite → "New Bot…"). */
  inviteTo: string | null;
}

/** The route's params, as `/bots/bot-form` receives them. */
export interface BotFormParams {
  botId?: string;
  /** A gallery key, or `custom` (= no template). */
  template?: string;
  requestId?: string;
  inviteTo?: string;
}

export type BotFormSource =
  | { status: 'loading' }
  /** The Bot is gone / archived, or the proposal was already decided. */
  | { status: 'missing' }
  | { status: 'ready'; init: BotFormInit };

// ─── Pre-fill ────────────────────────────────────────────

/** A template pre-fills its copy (pitch → purpose) and pins its plant, whatever its stored avatar says. */
export function templateValues(template: BotTemplate, lang: 'en' | 'zh'): BotFormValues {
  const copy = template.copy[lang];
  return {
    name: copy.name,
    role: copy.role,
    description: copy.pitch,
    instructions: copy.instructions,
    avatar: withPlant(template.avatar, TEMPLATE_PLANT[template.key]),
  };
}

/** A blank Bot wears a plant none of the member's Bots has yet. */
export function customValues(taken: readonly PlantId[]): BotFormValues {
  return { name: '', role: '', description: '', instructions: '', avatar: withPlant({}, freshPlant(taken)) };
}

export function botValues(bot: BotView): BotFormValues {
  return {
    name: bot.name,
    role: bot.role,
    description: bot.description,
    instructions: bot.instructions,
    avatar: bot.avatar ?? {},
  };
}

/** What another Bot proposed — read defensively (a card payload is stored JSON). */
export function proposalValues(payload: Partial<BotCreatePayload>): BotFormValues {
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  return {
    name: text(payload.name),
    role: text(payload.role),
    description: '',
    instructions: text(payload.instructions),
    avatar: payload.avatar && typeof payload.avatar === 'object' ? payload.avatar : {},
  };
}

/**
 * Which form the params ask for, once the data it needs is in: a proposal
 * (`requestId`, still pending) > an edit (`botId`, an active Bot) > a new Bot
 * (gallery `template`, else custom). Every mode waits for the Bot list — the
 * name check and a fresh plant both need it. `pendingChecked`: the pending
 * list was re-read since the sheet opened, so a card not in it is gone.
 */
export function resolveBotForm(
  params: BotFormParams,
  data: {
    bots: readonly BotView[];
    byId: Readonly<Record<string, BotView>>;
    botsLoaded: boolean;
    requests: ReadonlyMap<string, BotRequestView>;
    pendingChecked: boolean;
    lang: 'en' | 'zh';
  },
): BotFormSource {
  if (!data.botsLoaded) return { status: 'loading' };
  const base = { bot: null, request: null, inviteTo: null };
  if (params.requestId) {
    const request = data.requests.get(params.requestId);
    if (!request) return data.pendingChecked ? { status: 'missing' } : { status: 'loading' };
    if (request.kind !== 'bot_create' || request.status !== 'pending') return { status: 'missing' };
    const payload = request.payload as Partial<BotCreatePayload>;
    return {
      status: 'ready',
      init: {
        ...base,
        mode: 'proposal',
        values: proposalValues(payload),
        templateKey: typeof payload.template_key === 'string' ? payload.template_key : null,
        request,
      },
    };
  }
  if (params.botId) {
    const bot = data.byId[params.botId];
    if (!bot || bot.status !== 'active') return { status: 'missing' };
    return {
      status: 'ready',
      init: { ...base, mode: 'edit', values: botValues(bot), templateKey: bot.template_key, bot },
    };
  }
  const template = galleryTemplate(params.template);
  return {
    status: 'ready',
    init: {
      ...base,
      mode: 'create',
      values: template ? templateValues(template, data.lang) : customValues(data.bots.map(botPlant)),
      templateKey: template?.key ?? null,
      inviteTo: params.inviteTo || null,
    },
  };
}

// ─── Form state ──────────────────────────────────────────

/** Stored avatars are small flat objects: equal when every key holds the same value. */
export function avatarEqual(a: AvatarConfig | null | undefined, b: AvatarConfig | null | undefined): boolean {
  const flat = (avatar: AvatarConfig | null | undefined) =>
    JSON.stringify(Object.entries(avatar ?? {}).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
  return flat(a) === flat(b);
}

/** Unsaved edits (the sheet then confirms ✕ and blocks swipe-to-dismiss). */
export function botFormDirty(initial: BotFormValues, values: BotFormValues): boolean {
  return (
    initial.name !== values.name ||
    initial.role !== values.role ||
    initial.description !== values.description ||
    initial.instructions !== values.instructions ||
    !avatarEqual(initial.avatar, values.avatar)
  );
}

/** Fields over the server's limits (the native fields cap them too; this covers a long pre-fill). */
export function overLimits(values: BotFormValues): { role: boolean; description: boolean; instructions: boolean } {
  return {
    role: [...values.role.trim()].length > BOT_ROLE_MAX,
    description: values.description.trim().length > BOT_DESCRIPTION_MAX,
    instructions: values.instructions.trim().length > BOT_INSTRUCTIONS_MAX,
  };
}

/** ✓ is live: a valid name, nothing over a limit, and — for an edit — something changed. */
export function botFormCanSave(i: {
  mode: BotFormMode;
  initial: BotFormValues;
  values: BotFormValues;
  nameIssue: BotNameIssue | null;
}): boolean {
  if (i.nameIssue) return false;
  const over = overLimits(i.values);
  if (over.role || over.description || over.instructions) return false;
  return i.mode !== 'edit' || botFormDirty(i.initial, i.values);
}

/** The sheet's title: 新建 Bot / 新建 · 研究员 / 编辑 {name} / 确认新建. */
export function botFormTitle(
  init: Pick<BotFormInit, 'mode' | 'templateKey' | 'bot'>,
  lang: 'en' | 'zh',
): { key: TranslationKey; vars?: Record<string, string> } {
  if (init.mode === 'proposal') return { key: 'bots.manage.formProposal' };
  if (init.mode === 'edit') return { key: 'bots.manage.formEdit', vars: { name: init.bot?.name ?? '' } };
  const template = galleryTemplate(init.templateKey);
  return template
    ? { key: 'bots.manage.formTemplate', vars: { role: template.copy[lang].role } }
    : { key: 'bots.manage.formNew' };
}

/**
 * The form's computer warning: a new (or proposed) Bot from a template that
 * needs the computer, where the deployment has none ready. An unknown runtime
 * (the list has not said) warns nothing.
 */
export function needsComputerWarning(
  init: Pick<BotFormInit, 'mode' | 'templateKey'>,
  computer: ComputerRuntimeView | null,
): boolean {
  if (init.mode === 'edit' || !computer) return false;
  return !!botTemplate(init.templateKey)?.needsComputer && computer.state !== 'ready';
}

/** A name issue as the line under the name field; `required` has none (✓ just stays off). */
export function nameIssueKey(issue: BotNameIssue | null): TranslationKey | null {
  return issue && issue !== 'required' ? `bots.manage.nameErr.${issue}` : null;
}

// ─── Saving ──────────────────────────────────────────────

/** `POST /api/bots`: the template key (gallery only) and every field, trimmed. */
export function createInput(init: Pick<BotFormInit, 'templateKey'>, values: BotFormValues): BotWriteInput {
  const template = galleryTemplate(init.templateKey);
  return {
    ...(template ? { template_key: template.key } : {}),
    name: values.name.trim(),
    role: values.role.trim(),
    description: values.description.trim(),
    instructions: values.instructions.trim(),
    avatar: values.avatar,
  };
}

/** `PATCH /api/bots/:id`: only the fields that differ from the Bot as stored (each PATCH is a version). */
export function updatePatch(bot: BotView, values: BotFormValues): Omit<BotWriteInput, 'template_key'> {
  const patch: Omit<BotWriteInput, 'template_key'> = {};
  const name = values.name.trim();
  const role = values.role.trim();
  const description = values.description.trim();
  const instructions = values.instructions.trim();
  if (name !== bot.name.trim()) patch.name = name;
  if (role !== bot.role.trim()) patch.role = role;
  if (description !== bot.description.trim()) patch.description = description;
  if (instructions !== bot.instructions.trim()) patch.instructions = instructions;
  if (!avatarEqual(bot.avatar, values.avatar)) patch.avatar = values.avatar;
  return patch;
}

/** Accept a `bot_create` card with the member's edits (a proposal has no purpose field). */
export function proposalDecision(values: BotFormValues): BotRequestDecision {
  return {
    decision: 'approve',
    bot: {
      name: values.name.trim(),
      role: values.role.trim(),
      instructions: values.instructions.trim(),
      avatar: values.avatar,
    },
  };
}

/**
 * Where a refused save is explained. `bot_name_taken` goes back under the name
 * field (a Bot made elsewhere since the list loaded); `bot_limit` is the 20-Bot
 * rule (a system alert). The name rules are checked live with the server's own
 * copy, so a `bot_name_invalid` that still comes back is about something the
 * form could not see: the alert for the save (`failed`) carries the server's
 * own sentence.
 */
export type BotSaveFailure =
  | { kind: 'name'; issue: BotNameIssue }
  | { kind: 'alert'; key: TranslationKey; message?: string };

export function botSaveFailure(
  code: string | null,
  message: string,
  failed: 'bots.manage.createFailed' | 'bots.manage.saveFailed',
): BotSaveFailure {
  const issue = botNameIssueFromCode(code);
  if (issue === 'limit') return { kind: 'alert', key: 'bots.manage.limit' };
  if (issue === 'taken') return { kind: 'name', issue };
  return { kind: 'alert', key: failed, message: message || undefined };
}
