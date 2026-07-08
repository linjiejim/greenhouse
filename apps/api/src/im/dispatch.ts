/**
 * IM gateway — channel-agnostic dispatcher.
 *
 * Turns a normalized `InboundMessage` into a reply string. This is the shared
 * "brain": command handling, deep-link pairing, identity resolution, and running
 * one agent turn via the SAME headless runner the scheduler uses
 * (`runAgentInSession`). Platform workers own only transport (receive + send +
 * typing); everything here is platform-independent and dependency-injected so it
 * unit-tests without a live DB or LLM.
 */

import { getDb, type DatabaseProvider, type ImBotRow, type ImIdentityRow } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { resolveProfile } from '../profile.js';
import { selectTools, buildSystemPrompt, type ToolRegistry } from '../agent.js';
import { runAgentInSession, type AgentGenerate } from '../agent-runtime/run-agent.js';
import { sanitizeForPrompt, checkPromptInjection, InMemoryRateLimiter } from '../security.js';
import { redeemPairingCode } from './pairing.js';
import { IM_MAX_HISTORY_MESSAGES, IM_RATE_LIMIT_PER_MIN, type InboundMessage } from './types.js';

/** Dependencies for a dispatch — `db`/`generate` are injectable for tests. */
export interface DispatchContext {
  toolRegistry: ToolRegistry;
  db?: DatabaseProvider;
  generate?: AgentGenerate;
}

/** Slash commands advertised to the platform (Telegram setMyCommands). */
export const IM_COMMANDS: ReadonlyArray<{ command: string; description: string }> = [
  { command: 'help', description: 'Show what this bot can do' },
  { command: 'new', description: 'Start a new conversation' },
  { command: 'whoami', description: 'Show which Greenhouse account you are linked to' },
];

const rateLimiter = new InMemoryRateLimiter(120_000);

// ─── Entry point ──────────────────────────────────────────

/** Handle one inbound message and produce a reply. Never throws. */
export async function dispatchInbound(
  bot: ImBotRow,
  inbound: InboundMessage,
  ctx: DispatchContext,
): Promise<{ reply: string }> {
  const db = ctx.db ?? getDb();

  if (inbound.command) {
    switch (inbound.command) {
      case 'start':
        return { reply: await handleStart(db, bot, inbound) };
      case 'help':
        return { reply: helpText() };
      case 'new':
        return { reply: await handleNew(db, bot, inbound) };
      case 'whoami':
        return { reply: await handleWhoami(db, bot, inbound) };
      default:
        return { reply: `Unknown command /${inbound.command}.\n\n${helpText()}` };
    }
  }

  const identity = await db.im.getIdentity(bot.id, inbound.extUserId);
  if (!identity) return { reply: pairPromptText() };

  const rl = rateLimiter.check(`im:${bot.id}:${inbound.extUserId}`, 60_000, IM_RATE_LIMIT_PER_MIN);
  if (!rl.allowed) return { reply: '⏳ Too many messages — please slow down and try again shortly.' };

  return { reply: await runTurn(db, bot, identity, inbound, ctx) };
}

// ─── Commands ─────────────────────────────────────────────

async function handleStart(db: DatabaseProvider, bot: ImBotRow, inbound: InboundMessage): Promise<string> {
  if (!inbound.commandArg) {
    const existing = await db.im.getIdentity(bot.id, inbound.extUserId);
    if (existing)
      return `✅ You're linked to Greenhouse. Send me a message and I'll relay it to your agent.\n\n${helpText()}`;
    return pairPromptText();
  }

  const userId = await redeemPairingCode(bot.id, inbound.commandArg, db);
  if (!userId) {
    return '⚠️ That pairing code is invalid or has expired. Generate a fresh one in Greenhouse → Settings and try again.';
  }
  const user = await db.users.getById(userId);
  await db.im.upsertLink({
    bot_id: bot.id,
    channel: bot.channel,
    ext_user_id: inbound.extUserId,
    ext_chat_id: inbound.extChatId,
    user_id: userId,
    display_name: inbound.displayName ?? null,
  });
  const who = user?.nickname ?? user?.email ?? userId;
  return `✅ Linked to Greenhouse as ${who}. Send me a message and I'll relay it to your agent.\n\n${helpText()}`;
}

async function handleNew(db: DatabaseProvider, bot: ImBotRow, inbound: InboundMessage): Promise<string> {
  const identity = await db.im.getIdentity(bot.id, inbound.extUserId);
  if (!identity) return pairPromptText();
  await db.im.setIdentitySession(identity.id, null);
  return '🆕 Started a new conversation. Your next message begins a fresh session.';
}

async function handleWhoami(db: DatabaseProvider, bot: ImBotRow, inbound: InboundMessage): Promise<string> {
  const identity = await db.im.getIdentity(bot.id, inbound.extUserId);
  if (!identity) return pairPromptText();
  const user = await db.users.getById(identity.user_id);
  const who = user?.nickname ?? user?.email ?? identity.user_id;
  return `You're linked as ${who} (agent profile: ${bot.default_profile_id}).`;
}

// ─── Agent turn ───────────────────────────────────────────

async function runTurn(
  db: DatabaseProvider,
  bot: ImBotRow,
  identity: ImIdentityRow,
  inbound: InboundMessage,
  ctx: DispatchContext,
): Promise<string> {
  const profile = resolveProfile(bot.default_profile_id);

  // Resolve (or recreate) this identity's rolling conversation session.
  let sessionId = identity.session_id ?? null;
  if (sessionId && !(await db.sessions.getById(sessionId))) sessionId = null;
  if (!sessionId) {
    const title = `Telegram: ${identity.display_name ?? inbound.extUserId}`;
    const session = await db.sessions.create(title, bot.default_profile_id, identity.user_id, undefined, 'im');
    sessionId = session.id;
    await db.im.setIdentitySession(identity.id, sessionId);
  }

  // Conversation memory — prior user/assistant turns, capped for token safety.
  const history = (await db.sessions.buildChatMessages(sessionId))
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-IM_MAX_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  // Defense-in-depth: sanitize before the LLM (and before persisting to history);
  // log injection attempts.
  const sanitized = sanitizeForPrompt(inbound.text);
  if (!checkPromptInjection(inbound.text).safe) {
    logger.warn(`[IM] ⚠️ Possible prompt injection from telegram:${inbound.extUserId} (session ${sessionId})`);
  }

  await db.sessions.addMessage({ session_id: sessionId, role: 'user', content: sanitized });

  try {
    const result = await runAgentInSession({
      db,
      sessionId,
      system: buildSystemPrompt(profile),
      prompt: sanitized,
      priorMessages: history,
      modelConfig: profile.model,
      tools: selectTools(ctx.toolRegistry, profile.tools),
      maxSteps: profile.max_steps ?? 12,
      toolChoice: profile.tool_choice,
      generate: ctx.generate,
    });
    const text = result.text?.trim();
    return text && text.length > 0 ? text : '(the agent returned an empty response)';
  } catch (err) {
    logger.error(
      `[IM] ❌ Turn failed for telegram:${inbound.extUserId} (session ${sessionId}): ${toErrorMessage(err)}`,
    );
    return '⚠️ Something went wrong handling your message. Please try again.';
  }
}

// ─── Canned copy ──────────────────────────────────────────

function helpText(): string {
  const lines = IM_COMMANDS.map((c) => `/${c.command} — ${c.description}`);
  return ['I relay your messages to your Greenhouse agent. Commands:', ...lines].join('\n');
}

function pairPromptText(): string {
  return (
    "You're not linked to a Greenhouse account yet.\n\n" +
    'Open Greenhouse → Settings → Integrations, connect Telegram to get a one-time link, ' +
    'then tap it (or send /start <code> here).'
  );
}
