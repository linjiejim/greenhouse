/**
 * The tool faces of a Bot turn (spec §5, design review R1, decision D8).
 *
 * A Bots conversation is an untrusted-input session: a Bot reads web pages,
 * shell output and other Bots' words in the same turn it may act. So:
 * - interactive face = the member's own effective tools (a Bot never exceeds
 *   its owner) + the Bot tools; minus the card-only dispatch tools and
 *   `spawn_session` (background work is `bot_tasks`); `memory` is rebuilt
 *   Bot-scoped. Every tool that WRITES Greenhouse data is wrapped so that its
 *   execute first raises an approval card and runs only on the member's
 *   "Allow" — a model-set `confirm: true` is not consent;
 * - background face = see background.ts (read-only).
 *
 * The id list depends only on static configuration (feature flags, whether the
 * computer runtime is ready, whether the background-task driver is enabled),
 * never on per-turn state, so the system prompt and tool schemas stay
 * cacheable; keys are emitted in a fixed order.
 */

import type { Tool } from 'ai';
import type { DatabaseProvider } from '@greenhouse/db';
import type { ToolRegistry } from '../../agent.js';
import { selectTools } from '../../agent.js';
import { buildLazyServerTools, DISPATCH_TOOL_IDS, LAZY_TOOL_IDS } from '../../agent-runtime/tool-resolution.js';
import { peekDraftToken } from '../../email/security.js';
import { getSharedMailboxCredentials } from '../../email/service.js';
import { getToolMeta } from '../../tools/registry.js';
import { createMemoryTool } from '../../tools/memory.js';
import { botProfileId } from '../../profiles/profile.js';
import { runtimeDriverEnabled } from '../../trusted-execution/kill-switches.js';
import { buildComputerTools } from '../computer/index.js';
import { BOT_TOOL_IDS } from '../tools/meta.js';
import { createTeamTool } from '../tools/team.js';
import { createSelfTool } from '../tools/self.js';
import { createConversationTool } from '../tools/conversation.js';
import { createBotTasksTool } from '../tools/bot-tasks.js';
import type { BotTurnContext } from './context.js';
import type { ConversationPort, TeamPort } from './ports.js';
import { approvalFieldLabel, copy, toolActionPhrase, type BotsLocale } from './copy.js';

/**
 * Greenhouse writers that always need the member's approval in a Bots turn,
 * on top of anything the catalog declares `surface.proxy: 'write'`.
 */
export const BOT_APPROVAL_TOOL_IDS: ReadonlySet<string> = new Set([
  'knowledge_mutation',
  'tables_mutation',
  'project_mutation',
  'workbench_mutation',
  'skill_mutation',
  'automation_mutation',
  'email_mutation',
  'feature_request',
]);

/** Never in a Bots turn: card-only drafts and recursive spawning (D14). */
const EXCLUDED_TOOL_IDS: ReadonlySet<string> = new Set([...DISPATCH_TOOL_IDS, 'spawn_session', ...BOT_TOOL_IDS]);

export function needsBotApproval(toolId: string): boolean {
  return BOT_APPROVAL_TOOL_IDS.has(toolId) || getToolMeta(toolId)?.surface?.proxy === 'write';
}

/** The member tool ids a Bot may hold in an interactive turn. */
export function interactiveMemberToolIds(effectiveTools: readonly string[]): string[] {
  return effectiveTools.filter((id) => !EXCLUDED_TOOL_IDS.has(id));
}

/** Per value shown on an approval card, and for the whole card. */
export const APPROVAL_VALUE_MAX_CHARS = 4000;
export const APPROVAL_TOTAL_MAX_CHARS = 12_000;

/**
 * Argument keys an approval card never shows: consent flags the model sets
 * (not consent — the card is) and plumbing that does not change what the call
 * does: a Tables `revision` only guards against a concurrent edit, and an
 * email send's `draft_token` is replaced by the stored draft it names.
 */
export const APPROVAL_HIDDEN_FIELDS: ReadonlySet<string> = new Set([
  'confirm',
  'user_confirmed',
  'revision',
  'draft_token',
]);

/**
 * Detail lines for an approval card: the exact arguments THIS call will run
 * with (never the model's own wording of intent), labelled in the member's
 * locale. Nothing is dropped silently beyond `APPROVAL_HIDDEN_FIELDS` — the
 * member must be able to see what they allow: a long value ends with an
 * explicit "+N more characters" marker, and fields beyond the card's total
 * budget are counted on a final line. Both markers stay English: the clients
 * parse them and say them in the member's language.
 */
export function describeToolInput(input: unknown, locale: BotsLocale = 'en'): Array<{ label: string; value: string }> {
  if (!input || typeof input !== 'object') return [];
  const lines: Array<{ label: string; value: string }> = [];
  let used = 0;
  let hidden = 0;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (APPROVAL_HIDDEN_FIELDS.has(key) || value === undefined || value === null) continue;
    const text =
      typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : JSON.stringify(value);
    if (!text) continue;
    const room = Math.min(APPROVAL_VALUE_MAX_CHARS, APPROVAL_TOTAL_MAX_CHARS - used);
    if (room <= 0) {
      hidden += 1;
      continue;
    }
    const shown = text.length > room ? `${text.slice(0, room)}…(+${text.length - room} more characters)` : text;
    lines.push({ label: approvalFieldLabel(locale, key), value: shown });
    used += Math.min(text.length, room);
  }
  if (hidden > 0) lines.push({ label: '…', value: `+${hidden} more field${hidden === 1 ? '' : 's'}` });
  return lines;
}

/** How much of a stored email draft's body a send card shows (the draft card showed it whole). */
export const APPROVAL_EMAIL_BODY_PREVIEW_CHARS = 600;

function formatAddresses(addresses: ReadonlyArray<{ address: string; name?: string }> | undefined): string {
  return (addresses ?? []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ');
}

/** The address a draft will go out from — never a guess: unknown stays a mailbox reference. */
async function draftSender(db: DatabaseProvider, userId: string, accountRef: string, l: BotsLocale): Promise<string> {
  if (accountRef === 'shared') {
    return getSharedMailboxCredentials()?.email_address ?? copy.emailCard.sharedMailbox(l);
  }
  const id = Number(accountRef);
  try {
    const account = Number.isInteger(id) && id > 0 ? await db.email.getAccount(id) : undefined;
    if (account && account.user_id === userId) return account.email_address;
  } catch {
    // The card still says which draft it sends; the send resolves the mailbox itself.
  }
  return copy.emailCard.mailbox(l, accountRef);
}

/**
 * The card's detail lines for one call. Where the server ignores what the
 * model passes, the card must not show it: `email_mutation send` mails the
 * draft stored at `draft` time, so its card shows THAT draft — From, To, Cc,
 * Bcc, Subject and the start of the body, read without consuming the token —
 * never the recipients/subject/body the send call carries.
 */
export async function approvalDetails(
  toolId: string,
  input: unknown,
  owner: { db: DatabaseProvider; userId: string },
  locale: BotsLocale = 'en',
): Promise<Array<{ label: string; value: string }>> {
  const fields = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  if (toolId === 'email_mutation' && fields.action === 'send') {
    const label = (key: string) => approvalFieldLabel(locale, key);
    const token = typeof fields.draft_token === 'string' ? fields.draft_token : '';
    const lines = [{ label: label('action'), value: 'send' }];
    const draft = token ? peekDraftToken(token, owner.userId) : null;
    if (!draft) {
      lines.push({ label: label('note'), value: copy.emailCard.noDraft(locale) });
      return lines;
    }
    const body = draft.bodyText ?? '';
    const room = APPROVAL_EMAIL_BODY_PREVIEW_CHARS;
    lines.push({ label: label('from'), value: await draftSender(owner.db, owner.userId, draft.accountRef, locale) });
    lines.push({ label: label('to'), value: formatAddresses(draft.to) });
    if (draft.cc?.length) lines.push({ label: label('cc'), value: formatAddresses(draft.cc) });
    if (draft.bcc?.length) lines.push({ label: label('bcc'), value: formatAddresses(draft.bcc) });
    lines.push({ label: label('subject'), value: draft.subject });
    if (body) {
      lines.push({
        label: label('body'),
        value: body.length > room ? `${body.slice(0, room)}…(+${body.length - room} more characters)` : body,
      });
    }
    if (draft.attachmentIds?.length) {
      lines.push({ label: label('attachments'), value: copy.emailCard.files(locale, draft.attachmentIds.length) });
    }
    lines.push({ label: label('note'), value: copy.emailCard.sendsStored(locale) });
    return lines;
  }
  return describeToolInput(input, locale);
}

type ExecutableTool = { execute?: (input: unknown, options: unknown) => unknown } & Record<string, unknown>;

/** Wrap a writer so it runs only after the member allows THIS call on a card. */
export function withBotApproval(toolId: string, original: unknown, ctx: BotTurnContext): unknown {
  const tool = original as ExecutableTool;
  if (!tool || typeof tool.execute !== 'function') return original;
  const execute = tool.execute;
  // The fallback when the tool has no localized action phrase (copy.toolAction).
  const name = getToolMeta(toolId)?.name ?? toolId.replace(/_/g, ' ');
  return {
    ...tool,
    execute: async (input: unknown, options: unknown) => {
      const summary = toolActionPhrase(ctx.locale, { id: toolId, name, input });
      const decision = await ctx.requestApproval({
        action: 'tool_call',
        title: copy.approvalTitle(ctx.locale, ctx.bot.name, summary),
        summary,
        details: await approvalDetails(toolId, input, { db: ctx.db, userId: ctx.userId }, ctx.locale),
        allow_always: false,
      });
      if (decision === 'approve' || decision === 'always') return execute(input, options);
      return decision === 'expired'
        ? {
            status: 'expired',
            error:
              'The member did not answer the approval card in time — nothing was changed. Ask again only if they still want it.',
          }
        : {
            status: 'denied',
            error: 'The member declined this change — nothing was changed. Do not retry unless they ask.',
          };
    },
  };
}

export interface InteractiveToolsInput {
  db: DatabaseProvider;
  ctx: BotTurnContext;
  toolRegistry: ToolRegistry;
  effectiveTools: readonly string[];
  team: TeamPort;
  conversation: ConversationPort;
  runtimeRunId: string | null;
}

export interface InteractiveTools {
  tools: Record<string, Tool>;
  /** Whether any registered tool is approval-gated (S1 mentions the cards only then). */
  approvalGated: boolean;
}

export function assembleInteractiveTools(input: InteractiveToolsInput): InteractiveTools {
  const { db, ctx } = input;
  const ids = interactiveMemberToolIds(input.effectiveTools);
  const registry: ToolRegistry = selectTools(
    input.toolRegistry,
    ids.filter((id) => !LAZY_TOOL_IDS.has(id)),
  );
  Object.assign(
    registry,
    buildLazyServerTools(
      db,
      ids.filter((id) => id !== 'memory'),
      {
        userId: ctx.userId,
        userRole: ctx.userRole,
        sessionId: ctx.sessionId,
        // Sub-calls (call_llm) pick their model from the speaking Bot; the
        // knowledge tools see its reference folder and no other Bot's.
        profileId: botProfileId(ctx.bot.id),
        botId: ctx.bot.id,
        toolRegistry: input.toolRegistry,
        unattended: false,
        runtimeRunId: input.runtimeRunId,
      },
    ),
  );
  if (ids.includes('memory')) {
    registry.memory = createMemoryTool(db, {
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      bot: {
        botId: ctx.bot.id,
        // Read when the action executes, not now: reading a page later in this
        // same turn must lock the user-level layer (design review R1).
        userScopeAllowed: () => !ctx.isTainted() && ctx.userTriggered,
      },
    });
  }

  let approvalGated = false;
  for (const id of Object.keys(registry)) {
    if (!needsBotApproval(id)) continue;
    registry[id] = withBotApproval(id, registry[id], ctx);
    approvalGated = true;
  }

  registry.team = createTeamTool(ctx, input.team);
  registry.conversation = createConversationTool(ctx, input.conversation);
  registry.self = createSelfTool(ctx);
  // Offered only where background tasks can actually run (same check as the
  // greeting): otherwise S1 would promise them and every Start would fail.
  if (runtimeDriverEnabled('subagent')) registry.bot_tasks = createBotTasksTool(ctx);
  Object.assign(registry, buildComputerTools(ctx));

  // Fixed order: the tool list is part of the cached prompt prefix.
  const tools: Record<string, Tool> = {};
  for (const id of Object.keys(registry).sort()) tools[id] = registry[id] as Tool;
  return { tools, approvalGated };
}
