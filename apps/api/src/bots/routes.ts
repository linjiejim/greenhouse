/**
 * Bots 路由 — /api/bots（个人助理 Bot、对话、共享笔记、需要你、后台任务）
 *
 * GET    /api/bots                                    — 我的 Bot 列表（bots 仅 active；archived_bots 另列）+ 电脑运行时 + 密码库可用性 + 待处理请求数
 * POST   /api/bots/bootstrap                          — 确保内置主 Bot Sprouty 存在（+ 私聊 + 固定欢迎语）；幂等，每次进入都可调
 * POST   /api/bots                                    — 新建 Bot（模板库模板或自定义；不能建 Sprouty），同时建私聊并写欢迎语
 * GET    /api/bots/conversations                      — 对话列表（按活跃排序，含徽标状态）
 * GET    /api/bots/conversations?kind=task            — 任务会话（独立会话）列表；不带 kind 只列私聊与旧群
 * POST   /api/bots/conversations                      — 恰好 1 个 Bot → 它的私聊（群聊已退役：其他数量 400 groups_retired）；
 *                                                        {kind:'task', bot_id?, title?, model_id?} → 新任务会话（缺省 Sprouty）
 * PATCH  /api/bots/conversations/:id                  — 任务会话的模型 / 标题（{model_id?, title?}；私聊 409 not_task_chat）
 * POST   /api/bots/conversations/:id/rewind           — 任务会话：编辑最后一条成员消息后重跑 / 重新回答（NDJSON 流；有回合 409 busy）
 * GET    /api/bots/conversations/:id                  — 对话详情 + 消息分页（before_seq / limit）+ 本页记忆回执的当前状态
 * POST   /api/bots/conversations/:id/members          — 邀请 Bot 进私聊做客串（旧群聊只读：409 group_closed）
 * DELETE /api/bots/conversations/:id/members/:botId   — 移出客串 Bot（旧群聊只读：409 group_closed）
 * POST   /api/bots/conversations/:id/read             — 标记已读（同时把这段对话的「回复了你」提醒标为已读）
 * POST   /api/bots/conversations/:id/compact          — 立即整理摘要（有回合在跑时 409）
 * GET    /api/bots/conversations/:id/notes            — 共享笔记列表
 * POST   /api/bots/conversations/:id/notes            — 新建共享笔记
 * PATCH  /api/bots/conversations/:id/notes/:noteId    — 修改共享笔记
 * DELETE /api/bots/conversations/:id/notes/:noteId    — 删除共享笔记
 * GET    /api/bots/conversations/:id/tasks            — 本对话的后台任务
 * GET    /api/bots/tasks                              — 我全部对话的后台任务（?limit=，默认 20、最多 50；进行中在前，再列最近结束的），每行带派出它的对话 conversation_id（侧栏「后台」）
 * GET    /api/bots/tasks?state=active                 — 我所有对话里在跑的后台任务 + 最近 30 分钟内结束的（手机 Live Activity 对账用）
 * POST   /api/bots/tasks/:runId/cancel                — 取消后台任务（Runtime 取消语义）
 * GET    /api/bots/requests                           — 「需要你」请求（?status=pending）
 * POST   /api/bots/requests/:id                       — 处理请求（审批 / 建 Bot / 开始任务 / 登录 / 交还），已处理 409 already_decided、处理中 409 deciding、旧群聊的卡 409 group_closed
 * PATCH  /api/bots/:id                                — 修改 Bot 资料（追加一个不可变版本）
 * DELETE /api/bots/:id                                — 归档 Bot（Sprouty 不可归档：400 bot_protected）
 * GET    /api/bots/:id/versions                       — 不可变版本历史
 * GET    /api/bots/:id/usage?days=                    — 它的模型用量（按天：次数、token、对话数；默认 30 天、最多 90）
 * GET    /api/bots/:id/activity?limit=                — 它做过的事（平台动作 / 密码库使用 / 后台任务，新到旧，不含消息内容）
 * GET    /api/bots/:id/memories                       — 该 Bot 的私有记忆
 * DELETE /api/bots/:id/memories/:memoryId             — 删除一条私有记忆
 *
 * 身份类路径（列表、新建、修改、版本、记忆、文件）只要 requireInternal()；
 * 永续对话、请求、后台任务、bootstrap（建私聊）、电脑与密码库还要 requireFeature('bots')
 * （src/index.ts）——`bots` 开关只管永续线程与电脑，不管身份（spec 20261007 D5）。Bot 默认是私有的（公开 Agent 见 public.ts）：
 * 全部按当前用户 owner 作用域，他人的行与不存在的行一律 404，没有共享、评审或克隆。
 * 群聊已退役（2026-10-09）：对话就是某个 Bot 的私聊，其他 Bot 以客串身份加入（成员手动邀请或 Bot 的
 * team.add），交接永远允许；旧群聊保留为只读历史（发消息 / 邀请 / 移出 / 处理卡片一律 409 group_closed）。
 * 静态路径先于 /:id 注册（Hono 按注册顺序匹配）。
 * 契约：bots/AGENTS.md「HTTP 契约」。
 */

import { Hono } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import {
  BOTS_REPLY_DEDUPE_PREFIX,
  BotsDomainError,
  getDb,
  type BotRow,
  type ConversationWithMembers,
  type DatabaseProvider,
} from '@greenhouse/db';
import { avatarConfigSchema, type AvatarConfig } from '@greenhouse/types/profile-manifest';
import {
  BOT_DESCRIPTION_MAX,
  galleryTemplate,
  isSproutyBot,
  type BotActivityItem,
  type BotConversationDetail,
  type BotFeedbackView,
  type BotPublicationView,
  type BotPublicationWrite,
  type SharedBotView,
  type BotUsageView,
  type BotRequestStatus,
  type BotTemplateKey,
} from '@greenhouse/types/bots';
import type { BotVersionMeta } from '@greenhouse/db';
import { resolveUserTools } from '../agent.js';
import { userHasFeature } from '../auth/features.js';
import { botProfileId } from '../profiles/profile.js';
import { PLATFORM_ORG_ID } from '../platform/runtime.js';
import { getAllToolIds } from '../tools/registry.js';
import { ensureSproutyBot } from './sprouty.js';
import {
  conversationBotNames,
  publicationOf,
  publicBotFor,
  PublicationError,
  validatePublicationWrite,
} from './public.js';
import { ensureBotFolder, renameBotFolder } from './folder.js';
import { kbFolderSubtreeIds } from '../knowledge/folders.js';
import { entityUrl } from '@greenhouse/types/entity-links';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { safeJsonParse } from '@greenhouse/utils/json';
import { botNameKey } from '@greenhouse/db';
import type { AppEnv } from '../app-env.js';
import { getAuthUser } from '../auth/middleware.js';
import type { AuthUser } from '../auth/token.js';
import { chatRunRegistry } from '../chat/runs.js';
import { streamRunToResponse } from '../chat/turn.js';
import { admitRichBlocks } from '@greenhouse/types/rich-output';
import { isChatModelAllowed } from '../config/models.js';
import { connectionManager } from '../ws/connection-manager.js';
import { computerRefForBot, getComputerRuntime, stopComputer } from './computer/index.js';
import { pushAttention, resolveApprovalWaiter } from './engine/approvals.js';
import { botsLocale, copy, type BotsLocale } from './engine/copy.js';
import { compactConversation, digestView, DIGEST_TRIGGER_TOKENS, effectiveDigestUpto } from './engine/digest.js';
import { writeGreeting } from './engine/greeting.js';
import { deliverToConversation, engineToolRegistry } from './engine/inbox.js';
import { nextFreeName, validateBotInstructions, validateBotName, validateBotRole } from './engine/naming.js';
import { decideBotRequest, RequestDecisionError } from './engine/requests.js';
import {
  cancelBotTask,
  listConversationTasks,
  listMemberTaskHistory,
  listMemberTasks,
  MEMBER_TASKS_MAX,
} from './engine/tasks.js';
import { estimateRows, readTail } from './engine/transcript.js';
import { NOTE_BODY_MAX, NOTE_TITLE_MAX } from './tools/conversation.js';
import {
  toBotVersionView,
  toBotView,
  toSharedBotView,
  toConversationSummary,
  toMessageView,
  toNoteView,
  toRequestView,
  vaultAvailable,
  type BotMemoryState,
  type BotMessageView,
  type RoomViewExtras,
} from './views.js';
import { pushToConversation } from './engine/fanout.js';
import { roomViewExtras } from './room-access.js';

const MESSAGES_PAGE_DEFAULT = 60;
const MESSAGES_PAGE_MAX = 200;
const REQUESTS_IN_DETAIL = 50;

type BotFieldErrorCode = 'bot_name_invalid' | 'bot_name_taken' | 'bot_limit';

export async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export async function ownerContext(db: DatabaseProvider, userId: string) {
  const user = await db.users.getById(userId);
  return { nickname: user?.nickname ?? '', locale: botsLocale(user?.locale) };
}

/** DM session per Bot (the one conversation each Bot owns). */
async function dmIndex(db: DatabaseProvider, userId: string): Promise<Map<string, string>> {
  const conversations = await db.bots.listConversations(userId, 500);
  const map = new Map<string, string>();
  for (const conversation of conversations) {
    if (conversation.kind === 'direct' && conversation.owner_bot_id)
      map.set(conversation.owner_bot_id, conversation.session_id);
  }
  return map;
}

function parseModelId(raw: unknown): { ok: true; value: string | null | undefined } | { ok: false } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string' || !isChatModelAllowed(raw)) return { ok: false };
  return { ok: true, value: raw };
}

function parseAvatar(raw: unknown): { ok: true; value: AvatarConfig | undefined } | { ok: false } {
  if (raw === undefined) return { ok: true, value: undefined };
  const parsed = avatarConfigSchema.safeParse(raw);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

function parseDescription(raw: unknown): { ok: true; value: string | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: '' };
  if (typeof raw !== 'string') return { ok: false, error: 'description must be text' };
  const value = raw.replace(/[\r\n]+/g, ' ').trim();
  if ([...value].length > BOT_DESCRIPTION_MAX) {
    return { ok: false, error: `A description has at most ${BOT_DESCRIPTION_MAX} characters` };
  }
  return { ok: true, value };
}

/**
 * The Bot's tool filter. `null` / omitted = inherit the owner's whole allowed
 * set; a list must name known tools the owner may use (super skips the
 * ownership check, as the Agent editor always did) — a Bot can only narrow.
 */
async function parseTools(
  raw: unknown,
  user: Pick<AuthUser, 'id' | 'role'>,
): Promise<{ ok: true; value: string[] | null | undefined } | { ok: false; error: string; status: 400 | 403 }> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (!Array.isArray(raw) || raw.some((t) => typeof t !== 'string')) {
    return { ok: false, error: 'tools must be an array of tool ids or null', status: 400 };
  }
  const tools = [...new Set(raw as string[])];
  const known = new Set(getAllToolIds());
  const unknown = tools.filter((t) => !known.has(t));
  if (unknown.length > 0) return { ok: false, error: `Unknown tools: ${unknown.join(', ')}`, status: 400 };
  if (user.role !== 'super') {
    // The same resolver the tool picker is built from — see resolveUserTools.
    const { allowedTools } = await resolveUserTools(user.id, user.role);
    const allowed = new Set(allowedTools);
    const unauthorized = tools.filter((t) => !allowed.has(t));
    if (unauthorized.length > 0) {
      return { ok: false, error: `You don't have access to these tools: ${unauthorized.join(', ')}`, status: 403 };
    }
  }
  return { ok: true, value: tools };
}

/** More than any instance installs; a list this long is a mistake, not a choice. */
const MAX_BOT_CONNECTORS = 100;

/**
 * The Bot's connector list (spec 20261009-mcp-connectors D9). `null` /
 * omitted = every connector the owner can use; a list must name installed
 * connectors. Whether the owner may call them at all is decided at run time
 * (the `mcp_call` grant and their own connections) — a list only narrows.
 */
async function parseConnectors(
  raw: unknown,
): Promise<{ ok: true; value: string[] | null | undefined } | { ok: false; error: string }> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== 'string')) {
    return { ok: false, error: 'connectors must be an array of connector ids or null' };
  }
  const slugs = [...new Set(raw as string[])];
  if (slugs.length > MAX_BOT_CONNECTORS) {
    return { ok: false, error: `An Agent lists at most ${MAX_BOT_CONNECTORS} connectors` };
  }
  if (slugs.length === 0) return { ok: true, value: [] };
  const installed = new Set((await getDb().mcpServers.list()).map((row) => row.slug));
  const unknown = slugs.filter((slug) => !installed.has(slug));
  if (unknown.length > 0) return { ok: false, error: `Unknown connectors: ${unknown.join(', ')}` };
  return { ok: true, value: slugs };
}

const MAX_STEPS_LIMIT = 50;

function parseMaxSteps(raw: unknown): { ok: true; value: number | null | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_STEPS_LIMIT) {
    return { ok: false, error: `max_steps must be an integer between 1 and ${MAX_STEPS_LIMIT}` };
  }
  return { ok: true, value: raw };
}

/** Provenance of the version this request appends; `change_log` is optional free text. */
function parseVersionMeta(
  body: Record<string, unknown>,
  actorId: string,
): { ok: true; value: BotVersionMeta } | { ok: false; error: string } {
  const value: BotVersionMeta = { created_by: actorId };
  if (body.change_log !== undefined) {
    if (typeof body.change_log !== 'string' || body.change_log.length > 500) {
      return { ok: false, error: 'change_log must be text' };
    }
    value.change_log = body.change_log;
  }
  return { ok: true, value };
}

/** Whether this member may keep Bots conversations (the `bots` flag gates threads, not identity). */
async function conversationsEnabled(user: Pick<AuthUser, 'id' | 'role'>): Promise<boolean> {
  return userHasFeature(user.id, user.role, 'bots');
}

export async function conversationDetail(
  db: DatabaseProvider,
  userId: string,
  conversation: ConversationWithMembers,
  locale: BotsLocale,
): Promise<BotConversationDetail> {
  const sessionId = conversation.session_id;
  const [latest, unread, requests, notes, allBots, tail, room] = await Promise.all([
    db.bots.latestMessages([sessionId]),
    db.bots.unreadCounts([sessionId], userId),
    db.bots.listRequests(userId, { sessionId }),
    db.bots.listNotes(sessionId),
    conversationBotNames(
      db,
      userId,
      conversation.members.map((member) => member.bot_id),
    ),
    readTail(db, sessionId, effectiveDigestUpto(conversation)),
    conversation.kind === 'room' ? roomViewExtras(db, userId, conversation) : Promise.resolve(undefined),
  ]);
  const botNames = allBots;
  const pending = requests.filter((request) => request.status === 'pending').length;
  const summary = toConversationSummary(conversation, {
    lastMessage: latest.get(sessionId) ?? null,
    pendingRequests: pending,
    unreadCount: unread.get(sessionId) ?? 0,
    working: Boolean(chatRunRegistry.getActive(sessionId)),
    ...(room ? { room } : {}),
  });
  return {
    ...summary,
    description: conversation.description,
    // Hand-offs are always allowed; the column is deprecated (old clients still read the field).
    allow_bot_chat: true,
    digest: digestView(
      conversation.digest,
      conversation.digest_upto_seq,
      conversation.digest_updated_at,
      locale,
      botNames,
    ),
    notes: notes.map(toNoteView),
    requests: requests.slice(0, REQUESTS_IN_DETAIL).map(toRequestView),
    context: { estimated_tokens: estimateRows(tail.rows), threshold: DIGEST_TRIGGER_TOKENS },
  };
}

/** Memory receipts checked per page — a page of ≤200 messages never comes close. */
const MEMORY_STATES_MAX = 200;

/**
 * The current status of every memory a `memory` step on this page wrote, so
 * a receipt reloaded after the member undid it — here, or from the memory
 * settings — reads as undone. Owner-scoped (another member's id reads as
 * 'deleted'); undefined when the page has no memory steps.
 */
async function memoryStatesOf(
  db: DatabaseProvider,
  userId: string,
  messages: BotMessageView[],
): Promise<Record<string, BotMemoryState> | undefined> {
  const ids = new Set<number>();
  for (const message of messages) {
    for (const step of message.pipeline) {
      const id = rememberedMemoryId(step);
      if (id !== null && ids.size < MEMORY_STATES_MAX) ids.add(id);
    }
  }
  if (ids.size === 0) return undefined;
  const rows = await Promise.all([...ids].map((id) => db.userMemories.getOwned(id, userId)));
  const states: Record<string, BotMemoryState> = {};
  for (const id of ids) states[String(id)] = 'deleted';
  for (const row of rows) if (row) states[String(row.id)] = row.status;
  return states;
}

/** The memory id a `memory` pipeline step wrote (output may be stored as JSON text). */
function rememberedMemoryId(step: BotMessageView['pipeline'][number]): number | null {
  if (step.tool !== 'memory') return null;
  const output =
    typeof step.output === 'string' ? (safeJsonParse(step.output, null) as unknown) : (step.output as unknown);
  if (!output || typeof output !== 'object') return null;
  const remembered = (output as { remembered?: unknown }).remembered;
  if (!remembered || typeof remembered !== 'object') return null;
  const id = (remembered as { id?: unknown }).id;
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
}

export function domainStatus(error: BotsDomainError): 400 | 404 | 409 {
  switch (error.code) {
    case 'bot_not_found':
    case 'conversation_not_found':
    case 'note_not_found':
      return 404;
    case 'already_member':
    case 'group_closed':
    case 'room_full':
      return 409;
    default:
      return 400;
  }
}

/** An owner's view of its Agent's publication. */
async function publicationView(db: DatabaseProvider, bot: BotRow): Promise<BotPublicationView> {
  return {
    ...publicationOf(bot),
    visibility: bot.visibility,
    published_version: bot.published_version,
    current_version: bot.current_version,
    paused: bot.public_paused,
    users: await db.bots.countBotUsers(bot.id),
  };
}

function notifyConversation(userId: string, sessionId: string): void {
  void pushToConversation(sessionId, userId, { type: 'bots:conversation', sessionId });
}

export function createBotsRoutes() {
  return (
    new Hono<AppEnv>()
      // ── GET /api/bots ──
      .get('/', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const [all, dms, pending] = await Promise.all([
          db.bots.listBots(user.id, { includeArchived: true }),
          dmIndex(db, user.id),
          db.bots.countPendingRequests(user.id),
        ]);
        // Other members' public Agents this member talks to (P4): names and avatars for the threads.
        const own = new Set(all.map((bot) => bot.id));
        const sharedBots: SharedBotView[] = [];
        for (const conversation of await db.bots.listConversations(user.id)) {
          const botId = conversation.owner_bot_id;
          if (!botId || own.has(botId) || conversation.kind !== 'direct') continue;
          const usable = await publicBotFor(db, user.id, botId);
          const row = usable ?? (await db.bots.getBotById(botId));
          if (!row) continue;
          const ownerUser = await db.users.getById(row.user_id);
          sharedBots.push(
            toSharedBotView(
              row,
              { id: row.user_id, nickname: ownerUser?.nickname || ownerUser?.email || '' },
              conversation.session_id,
              usable !== null,
            ),
          );
        }
        // Archived Bots ride along separately: their DMs stay readable and old
        // messages, audit rows and receipts still need a name for them.
        return c.json({
          shared_bots: sharedBots,
          bots: all.filter((bot) => bot.status === 'active').map((bot) => toBotView(bot, dms.get(bot.id) ?? null)),
          archived_bots: all
            .filter((bot) => bot.status === 'archived')
            .map((bot) => toBotView(bot, dms.get(bot.id) ?? null)),
          computer: getComputerRuntime(),
          vault_available: vaultAvailable(),
          pending_requests: pending,
        });
      })

      // ── POST /api/bots/bootstrap — idempotent: every member has Sprouty ──
      .post('/bootstrap', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        // The Bot row itself may already exist (Chat creates it on first use);
        // this route additionally guarantees the DM and its fixed greeting.
        const existed = Boolean((await db.bots.listBots(user.id)).find((bot) => isSproutyBot(bot)));
        const bot = await ensureSproutyBot(db, user.id);
        const dms = await dmIndex(db, user.id);
        const hadDm = dms.has(bot.id);
        const dm = await db.bots.ensureDirectConversation(user.id, bot.id);
        if (!hadDm) await writeGreeting(db, dm.session_id, bot);
        return c.json({ bot: toBotView(bot, dm.session_id), dm_session_id: dm.session_id, created: !existed });
      })

      // ── POST /api/bots — new Bot (template copy or custom) ──
      .post('/', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const body = await readJson(c);
        const owner = await ownerContext(db, user.id);
        const templateKey = typeof body.template_key === 'string' ? (body.template_key as BotTemplateKey) : undefined;
        // The gallery only: Sprouty comes from bootstrap, retired templates are history.
        const template = templateKey ? galleryTemplate(templateKey) : undefined;
        if (templateKey && !template)
          return c.json({ error: 'Unknown template', code: 'bot_name_invalid' as const }, 400);
        const templateCopy = template?.copy[owner.locale];

        let rawName = body.name;
        if ((rawName === undefined || rawName === '') && templateCopy) {
          const active = await db.bots.listBots(user.id);
          rawName = nextFreeName(
            templateCopy.name,
            new Set([...active.map((bot) => bot.name_key), botNameKey(owner.nickname)]),
          );
        }
        const name = validateBotName(rawName, owner.nickname);
        if (!name.ok) return c.json({ error: name.error, code: name.code as BotFieldErrorCode }, 400);
        const role = validateBotRole(body.role ?? templateCopy?.role);
        if (!role.ok) return c.json({ error: role.error, code: role.code as BotFieldErrorCode }, 400);
        const instructions = validateBotInstructions(body.instructions ?? templateCopy?.instructions);
        if (!instructions.ok)
          return c.json({ error: instructions.error, code: instructions.code as BotFieldErrorCode }, 400);
        const avatar = parseAvatar(body.avatar ?? template?.avatar);
        if (!avatar.ok) return c.json({ error: 'Invalid avatar', code: 'bot_name_invalid' as const }, 400);
        const modelId = parseModelId(body.model_id);
        if (!modelId.ok)
          return c.json({ error: 'That model is not available', code: 'bot_name_invalid' as const }, 400);
        const description = parseDescription(body.description ?? templateCopy?.pitch);
        if (!description.ok) return c.json({ error: description.error, code: 'bot_name_invalid' as const }, 400);
        const tools = await parseTools(body.tools, user);
        if (!tools.ok) return c.json({ error: tools.error, code: 'bot_name_invalid' as const }, tools.status);
        const connectors = await parseConnectors(body.connectors);
        if (!connectors.ok) return c.json({ error: connectors.error, code: 'bot_name_invalid' as const }, 400);
        const maxSteps = parseMaxSteps(body.max_steps);
        if (!maxSteps.ok) return c.json({ error: maxSteps.error, code: 'bot_name_invalid' as const }, 400);
        const meta = parseVersionMeta(body, user.id);
        if (!meta.ok) return c.json({ error: meta.error, code: 'bot_name_invalid' as const }, 400);

        try {
          const bot = await db.bots.createBot({
            user_id: user.id,
            name: name.name,
            role: role.role,
            description: description.value ?? '',
            instructions: instructions.instructions,
            avatar: JSON.stringify(avatar.value ?? {}),
            model_id: modelId.value ?? null,
            tools: tools.value ?? null,
            connectors: connectors.value ?? null,
            max_steps: maxSteps.value ?? null,
            template_key: template?.key ?? null,
            ...meta.value,
          });
          // The DM only exists where Bots threads do (the `bots` flag); the
          // identity is usable from Chat either way.
          if (!(await conversationsEnabled(user))) return c.json({ bot: toBotView(bot, null), dm_session_id: null });
          const dm = await db.bots.ensureDirectConversation(user.id, bot.id);
          await writeGreeting(db, dm.session_id, bot);
          return c.json({ bot: toBotView(bot, dm.session_id), dm_session_id: dm.session_id });
        } catch (error) {
          if (error instanceof BotsDomainError && (error.code === 'bot_name_taken' || error.code === 'bot_limit')) {
            return c.json({ error: error.message, code: error.code as BotFieldErrorCode }, 400);
          }
          throw error;
        }
      })

      // ── GET /api/bots/conversations — threads (DMs + retired groups), or ?kind=task chats ──
      .get('/conversations', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const kind = c.req.query('kind');
        if (kind !== undefined && kind !== 'task') return c.json({ error: 'kind must be "task"' }, 400);
        const [conversations, pending] = await Promise.all([
          kind === 'task'
            ? db.bots.listConversations(user.id, 100, { kinds: ['task'] })
            : db.bots.listConversations(user.id),
          db.bots.listRequests(user.id, { status: 'pending' }),
        ]);
        const sessionIds = conversations.map((conversation) => conversation.session_id);
        const [latest, unread] = await Promise.all([
          db.bots.latestMessages(sessionIds),
          db.bots.unreadCounts(sessionIds, user.id),
        ]);
        const rooms = new Map<string, RoomViewExtras>();
        for (const conversation of conversations) {
          if (conversation.kind === 'room') {
            rooms.set(conversation.session_id, await roomViewExtras(db, user.id, conversation));
          }
        }
        const pendingBySession = new Map<string, number>();
        for (const request of pending) {
          pendingBySession.set(request.session_id, (pendingBySession.get(request.session_id) ?? 0) + 1);
        }
        return c.json({
          conversations: conversations.map((conversation) =>
            toConversationSummary(conversation, {
              lastMessage: latest.get(conversation.session_id) ?? null,
              pendingRequests: pendingBySession.get(conversation.session_id) ?? 0,
              unreadCount: unread.get(conversation.session_id) ?? 0,
              working: Boolean(chatRunRegistry.getActive(conversation.session_id)),
              ...(rooms.has(conversation.session_id) ? { room: rooms.get(conversation.session_id)! } : {}),
            }),
          ),
        });
      })

      // ── POST /api/bots/conversations — the one Bot's DM (group chats are retired), or a new task chat ──
      .post('/conversations', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const body = await readJson(c);
        if (body.kind === 'task') {
          const title = body.title === undefined || body.title === null ? null : body.title;
          if (title !== null && typeof title !== 'string') return c.json({ error: 'title must be text' }, 400);
          const model = parseModelId(body.model_id);
          if (!model.ok) return c.json({ error: 'model_id is not an available model' }, 400);
          if (body.bot_id !== undefined && typeof body.bot_id !== 'string') {
            return c.json({ error: 'bot_id must be a Bot id' }, 400);
          }
          const botId = typeof body.bot_id === 'string' ? body.bot_id : (await ensureSproutyBot(db, user.id)).id;
          const owner = await ownerContext(db, user.id);
          try {
            const conversation = await db.bots.createTaskConversation(user.id, botId, {
              title,
              modelId: model.value ?? null,
            });
            notifyConversation(user.id, conversation.session_id);
            return c.json({ conversation: await conversationDetail(db, user.id, conversation, owner.locale) }, 201);
          } catch (error) {
            if (error instanceof BotsDomainError)
              return c.json({ error: error.message, code: error.code }, domainStatus(error));
            throw error;
          }
        }
        const botIds = Array.isArray(body.bot_ids) ? body.bot_ids : null;
        if (!botIds || botIds.some((id) => typeof id !== 'string')) {
          return c.json({ error: 'bot_ids must be a list of Bot ids' }, 400);
        }
        const ids = [...new Set(botIds as string[])];
        if (ids.length !== 1) {
          return c.json(
            { error: 'Group chats are retired — pass exactly one Bot id', code: 'groups_retired' as const },
            400,
          );
        }
        const botId = ids[0]!;
        const owner = await ownerContext(db, user.id);
        try {
          const conversation = await db.bots.ensureDirectConversation(user.id, botId);
          const bot = await db.bots.getBot(user.id, botId);
          if (bot) await writeGreeting(db, conversation.session_id, bot);
          return c.json({ conversation: await conversationDetail(db, user.id, conversation, owner.locale) });
        } catch (error) {
          if (error instanceof BotsDomainError)
            return c.json({ error: error.message, code: error.code }, domainStatus(error));
          throw error;
        }
      })

      // ── GET /api/bots/conversations/:id — detail + a page of messages ──
      .get('/conversations/:id', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const conversation = await db.bots.getConversation(user.id, c.req.param('id'));
        if (!conversation) return c.json({ error: 'Conversation not found' }, 404);
        const limitRaw = Number(c.req.query('limit'));
        const limit =
          Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MESSAGES_PAGE_MAX) : MESSAGES_PAGE_DEFAULT;
        const beforeRaw = Number(c.req.query('before_seq'));
        const beforeSeq = Number.isInteger(beforeRaw) && beforeRaw >= 0 ? beforeRaw : undefined;
        const owner = await ownerContext(db, user.id);
        const [page, detail] = await Promise.all([
          db.sessions.getMessagePage(conversation.session_id, {
            limit,
            ...(beforeSeq !== undefined ? { beforeSeq } : {}),
          }),
          conversationDetail(db, user.id, conversation, owner.locale),
        ]);
        const messages = page.messages.map(toMessageView);
        const memoryStates = await memoryStatesOf(db, user.id, messages);
        // The member's own ratings of these replies (P4 feedback), so the thumbs survive a reload.
        const ratings = await db.bots.listMyFeedback(
          user.id,
          messages.filter((m) => m.role === 'assistant' && m.bot_id).map((m) => m.id),
        );
        return c.json({
          conversation: detail,
          messages,
          has_more: page.has_more,
          ...(memoryStates ? { memory_states: memoryStates } : {}),
          ...(ratings.size > 0 ? { my_ratings: Object.fromEntries(ratings) } : {}),
        });
      })

      // ── POST /api/bots/conversations/:id/messages/:messageId/feedback — rate a reply (P4, D38) ──
      .post('/conversations/:id/messages/:messageId/feedback', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const body = await readJson(c);
        const rating = body.rating === 1 || body.rating === -1 ? (body.rating as 1 | -1) : null;
        if (rating === null) return c.json({ error: 'rating must be 1 or -1' }, 400);
        if (body.comment !== undefined && (typeof body.comment !== 'string' || body.comment.length > 1000)) {
          return c.json({ error: 'comment must be text of at most 1000 characters' }, 400);
        }
        const conversation = await db.bots.getConversation(user.id, c.req.param('id'));
        if (!conversation) return c.json({ error: 'Conversation not found' }, 404);
        const message = await db.sessions.getMessageById(c.req.param('messageId'));
        if (
          !message ||
          message.session_id !== conversation.session_id ||
          message.role !== 'assistant' ||
          !message.bot_id
        ) {
          return c.json({ error: 'Reply not found' }, 404);
        }
        const bot = (await db.bots.getBot(user.id, message.bot_id)) ?? (await db.bots.getBotById(message.bot_id));
        if (!bot) return c.json({ error: 'Reply not found' }, 404);
        const row = await db.bots.upsertFeedback({
          bot_id: bot.id,
          user_id: user.id,
          session_id: conversation.session_id,
          message_id: message.id,
          rating,
          comment: typeof body.comment === 'string' ? body.comment.trim() : '',
          version: bot.user_id === user.id ? null : bot.published_version,
        });
        return c.json({ ok: true as const, rating: row.rating });
      })

      // ── DELETE /api/bots/conversations/:id/messages/:messageId/feedback — take a rating back ──
      .delete('/conversations/:id/messages/:messageId/feedback', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const conversation = await db.bots.getConversation(user.id, c.req.param('id'));
        if (!conversation) return c.json({ error: 'Conversation not found' }, 404);
        const message = await db.sessions.getMessageById(c.req.param('messageId'));
        if (!message || message.session_id !== conversation.session_id) {
          return c.json({ error: 'Reply not found' }, 404);
        }
        await db.bots.deleteFeedback(user.id, message.id);
        return c.json({ ok: true as const });
      })

      // ── PATCH /api/bots/conversations/:id — a task chat's model / title ──
      .patch('/conversations/:id', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const body = await readJson(c);
        const model = parseModelId(body.model_id);
        if (!model.ok) return c.json({ error: 'model_id is not an available model' }, 400);
        if (body.title !== undefined && body.title !== null && typeof body.title !== 'string') {
          return c.json({ error: 'title must be text' }, 400);
        }
        const existing = await db.bots.getConversation(user.id, c.req.param('id'));
        if (!existing) return c.json({ error: 'Conversation not found' }, 404);
        if (existing.kind !== 'task') {
          return c.json({ error: 'Only a separate chat has its own model and title', code: 'not_task_chat' }, 409);
        }
        const updated = await db.bots.updateTaskConversation(user.id, existing.session_id, {
          ...(model.value !== undefined ? { modelId: model.value } : {}),
          ...(body.title !== undefined ? { title: body.title as string | null } : {}),
        });
        if (!updated) return c.json({ error: 'Conversation not found' }, 404);
        notifyConversation(user.id, updated.session_id);
        const owner = await ownerContext(db, user.id);
        return c.json({ conversation: await conversationDetail(db, user.id, updated, owner.locale) });
      })

      // ── POST /api/bots/conversations/:id/rewind — edit the last message / answer it again ──
      .post('/conversations/:id/rewind', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const body = await readJson(c);
        if (typeof body.message_id !== 'string' || !body.message_id) {
          return c.json({ error: 'message_id is required' }, 400);
        }
        if (body.content !== undefined && (typeof body.content !== 'string' || !body.content.trim())) {
          return c.json({ error: 'content must be non-empty text' }, 400);
        }
        const conversation = await db.bots.getConversation(user.id, c.req.param('id'));
        const session = conversation ? await db.sessions.getById(conversation.session_id) : undefined;
        if (!conversation || !session) return c.json({ error: 'Conversation not found' }, 404);
        if (conversation.kind !== 'task') {
          return c.json({ error: 'Only a separate chat can be edited or answered again', code: 'not_task_chat' }, 409);
        }
        const engine = await import('./engine/index.js');
        if ((await engine.conversationReplyState(db, user.id, session.id)) !== 'ok') {
          return c.json(
            { error: 'This Agent was archived — its conversation is read-only', code: 'bot_archived' },
            409,
          );
        }
        const registry = engineToolRegistry();
        if (!registry) return c.json({ error: 'Agents are starting up — try again' }, 503);
        const run = await engine.claimBotsRun(db, session.id, user.id);
        if (!run) return c.json({ error: 'A reply is still running here', code: 'busy' }, 409);
        try {
          // Cards left from the answer being replaced would decide nothing any more. A sign-in or a
          // takeover holds the computer, so those are finished on their card first.
          const pending = await db.bots.listRequests(user.id, { sessionId: session.id, status: 'pending' });
          if (pending.some((request) => request.kind === 'login' || request.kind === 'takeover')) {
            await engine.releaseBotsRun(db, run);
            return c.json({ error: 'Finish the computer card first', code: 'requests_pending' }, 409);
          }
          for (const request of pending) await db.bots.settleRequest(user.id, request.id, 'canceled');
          if (pending.length > 0) await pushAttention(db, user.id);
          await engine.startBotsRewind({
            authUser: user,
            session,
            toolRegistry: registry,
            run,
            messageId: body.message_id,
            ...(typeof body.content === 'string' ? { content: body.content } : {}),
            db,
            richBlocks: admitRichBlocks(body.rich_blocks),
          });
        } catch (error) {
          await engine.releaseBotsRun(db, run);
          if (error instanceof engine.RewindError) {
            return c.json({ error: error.message, code: error.code }, error.code === 'not_found' ? 404 : 409);
          }
          throw error;
        }
        c.header('Content-Type', 'application/x-ndjson');
        c.header('Cache-Control', 'no-cache');
        c.header('X-Accel-Buffering', 'no');
        c.header('X-Session-Id', session.id);
        return honoStream(c, (stream) => streamRunToResponse(run, stream, -1));
      })

      // ── POST /api/bots/conversations/:id/members ──
      .post('/conversations/:id/members', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const sessionId = c.req.param('id');
        const body = await readJson(c);
        if (typeof body.bot_id !== 'string') return c.json({ error: 'bot_id is required' }, 400);
        const owner = await ownerContext(db, user.id);
        // Someone else's public Agent talks with this member alone (P4: multi-party is P5).
        const target = await db.bots.getConversation(user.id, sessionId);
        if (target?.owner_bot_id && !(await db.bots.getBot(user.id, target.owner_bot_id))) {
          return c.json(
            { error: "Agents can't be invited into a conversation with someone else's Agent", code: 'public_agent' },
            409,
          );
        }
        try {
          await db.bots.addMember(user.id, sessionId, body.bot_id, 'user');
        } catch (error) {
          if (error instanceof BotsDomainError)
            return c.json({ error: error.message, code: error.code }, domainStatus(error));
          throw error;
        }
        const bot = await db.bots.getBot(user.id, body.bot_id);
        await deliverToConversation(sessionId, {
          kind: 'event',
          text: copy.joined(owner.locale, bot?.name ?? body.bot_id),
          event: { kind: 'joined', bot_id: body.bot_id, by: 'user' },
        });
        const fresh = await db.bots.getConversation(user.id, sessionId);
        if (!fresh) return c.json({ error: 'Conversation not found' }, 404);
        notifyConversation(user.id, sessionId);
        return c.json({ conversation: await conversationDetail(db, user.id, fresh, owner.locale) });
      })

      // ── DELETE /api/bots/conversations/:id/members/:botId ──
      .delete('/conversations/:id/members/:botId', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const sessionId = c.req.param('id');
        const botId = c.req.param('botId');
        const owner = await ownerContext(db, user.id);
        let removed: boolean;
        try {
          removed = await db.bots.removeMember(user.id, sessionId, botId);
        } catch (error) {
          if (error instanceof BotsDomainError)
            return c.json({ error: error.message, code: error.code }, domainStatus(error));
          throw error;
        }
        if (!removed) return c.json({ error: 'That Agent is not in this conversation' }, 404);
        const bot = await db.bots.getBot(user.id, botId);
        await deliverToConversation(sessionId, {
          kind: 'event',
          text: copy.left(owner.locale, bot?.name ?? botId),
          event: { kind: 'left', bot_id: botId },
        });
        const fresh = await db.bots.getConversation(user.id, sessionId);
        if (!fresh) return c.json({ error: 'Conversation not found' }, 404);
        notifyConversation(user.id, sessionId);
        return c.json({ conversation: await conversationDetail(db, user.id, fresh, owner.locale) });
      })

      // ── POST /api/bots/conversations/:id/read — also marks its missed-reply alerts read ──
      .post('/conversations/:id/read', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const conversation = await db.bots.getConversation(user.id, c.req.param('id'));
        if (!conversation) return c.json({ error: 'Conversation not found' }, 404);
        await db.bots.markRead(user.id, conversation.session_id);
        const cleared = await db.notifications.markReadByDedupePrefix(
          user.id,
          `${BOTS_REPLY_DEDUPE_PREFIX}${conversation.session_id}:`,
        );
        if (cleared > 0) {
          connectionManager.sendToUser(user.id, {
            type: 'notification:summary',
            unread: await db.notifications.countUnread(user.id),
          });
        }
        return c.json({ ok: true as const });
      })

      // ── POST /api/bots/conversations/:id/compact — manual "tidy up" ──
      .post('/conversations/:id/compact', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const sessionId = c.req.param('id');
        const conversation = await db.bots.getConversation(user.id, sessionId);
        if (!conversation) return c.json({ error: 'Conversation not found' }, 404);
        if (chatRunRegistry.getActive(sessionId)) {
          return c.json({ error: 'An Agent is replying — try again when it has finished' }, 409);
        }
        const outcome = await compactConversation(sessionId, {
          force: true,
          db,
          onDivider: async (uptoSeq, locale) => {
            await deliverToConversation(sessionId, {
              kind: 'event',
              text: copy.digest(locale),
              event: { kind: 'digest', upto_seq: uptoSeq },
            });
          },
        });
        if (outcome.status === 'busy')
          return c.json({ error: 'An Agent is replying — try again when it has finished' }, 409);
        if (outcome.status === 'failed')
          return c.json({ error: 'Could not update the summary right now — try again later' }, 502);
        notifyConversation(user.id, sessionId);
        return c.json({ digest: outcome.digest });
      })

      // ── GET /api/bots/conversations/:id/notes ──
      .get('/conversations/:id/notes', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const conversation = await db.bots.getConversation(user.id, c.req.param('id'));
        if (!conversation) return c.json({ error: 'Conversation not found' }, 404);
        const notes = await db.bots.listNotes(conversation.session_id);
        return c.json({ notes: notes.map(toNoteView) });
      })

      // ── POST /api/bots/conversations/:id/notes ──
      .post('/conversations/:id/notes', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const conversation = await db.bots.getConversation(user.id, c.req.param('id'));
        if (!conversation) return c.json({ error: 'Conversation not found' }, 404);
        const body = await readJson(c);
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        if (!title || title.length > NOTE_TITLE_MAX)
          return c.json({ error: `A note needs a title (≤${NOTE_TITLE_MAX} characters)` }, 400);
        if (body.body !== undefined && (typeof body.body !== 'string' || body.body.length > NOTE_BODY_MAX)) {
          return c.json({ error: `A note body has at most ${NOTE_BODY_MAX} characters` }, 400);
        }
        try {
          const note = await db.bots.addNote(conversation.session_id, {
            title,
            body: typeof body.body === 'string' ? body.body : '',
            pinned: body.pinned === true,
            author_bot_id: null,
          });
          notifyConversation(user.id, conversation.session_id);
          return c.json({ note: toNoteView(note) });
        } catch (error) {
          if (error instanceof BotsDomainError)
            return c.json({ error: error.message, code: error.code }, domainStatus(error));
          throw error;
        }
      })

      // ── PATCH /api/bots/conversations/:id/notes/:noteId ──
      .patch('/conversations/:id/notes/:noteId', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const conversation = await db.bots.getConversation(user.id, c.req.param('id'));
        if (!conversation) return c.json({ error: 'Conversation not found' }, 404);
        const noteId = Number(c.req.param('noteId'));
        if (!Number.isInteger(noteId) || noteId <= 0) return c.json({ error: 'Note not found' }, 404);
        const body = await readJson(c);
        const updates: { title?: string; body?: string; status?: 'open' | 'done'; pinned?: boolean } = {};
        if (body.title !== undefined) {
          const title = typeof body.title === 'string' ? body.title.trim() : '';
          if (!title || title.length > NOTE_TITLE_MAX)
            return c.json({ error: `A note needs a title (≤${NOTE_TITLE_MAX} characters)` }, 400);
          updates.title = title;
        }
        if (body.body !== undefined) {
          if (typeof body.body !== 'string' || body.body.length > NOTE_BODY_MAX) {
            return c.json({ error: `A note body has at most ${NOTE_BODY_MAX} characters` }, 400);
          }
          updates.body = body.body;
        }
        if (body.status !== undefined) {
          if (body.status !== 'open' && body.status !== 'done')
            return c.json({ error: 'status must be open or done' }, 400);
          updates.status = body.status;
        }
        if (body.pinned !== undefined) {
          if (typeof body.pinned !== 'boolean') return c.json({ error: 'pinned must be a boolean' }, 400);
          updates.pinned = body.pinned;
        }
        const note = await db.bots.updateNote(conversation.session_id, noteId, updates);
        if (!note) return c.json({ error: 'Note not found' }, 404);
        notifyConversation(user.id, conversation.session_id);
        return c.json({ note: toNoteView(note) });
      })

      // ── DELETE /api/bots/conversations/:id/notes/:noteId ──
      .delete('/conversations/:id/notes/:noteId', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const conversation = await db.bots.getConversation(user.id, c.req.param('id'));
        if (!conversation) return c.json({ error: 'Conversation not found' }, 404);
        const noteId = Number(c.req.param('noteId'));
        if (!Number.isInteger(noteId) || !(await db.bots.deleteNote(conversation.session_id, noteId))) {
          return c.json({ error: 'Note not found' }, 404);
        }
        notifyConversation(user.id, conversation.session_id);
        return c.json({ ok: true as const });
      })

      // ── GET /api/bots/conversations/:id/tasks ──
      .get('/conversations/:id/tasks', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const conversation = await db.bots.getConversation(user.id, c.req.param('id'));
        if (!conversation) return c.json({ error: 'Conversation not found' }, 404);
        return c.json({ tasks: await listConversationTasks(db, user.id, conversation.session_id) });
      })

      // ── GET /api/bots/tasks — every conversation's background tasks: the sidebar's "Background" (bare)
      //    and the phone's Live Activity reconcile (?state=active) ──
      .get('/tasks', async (c) => {
        const user = getAuthUser(c);
        const state = c.req.query('state');
        if (state === 'active') return c.json({ tasks: await listMemberTasks(getDb(), user.id) });
        if (state !== undefined) return c.json({ error: 'state must be "active"' }, 400);
        const raw = Number(c.req.query('limit') ?? 20);
        const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, MEMBER_TASKS_MAX) : 20;
        return c.json({ tasks: await listMemberTaskHistory(getDb(), user.id, limit) });
      })

      // ── POST /api/bots/tasks/:runId/cancel ──
      .post('/tasks/:runId/cancel', async (c) => {
        const user = getAuthUser(c);
        const result = await cancelBotTask(getDb(), user.id, c.req.param('runId'));
        if (result === 'not_found') return c.json({ error: 'Task not found' }, 404);
        if (result === 'finished') return c.json({ error: 'That task has already finished' }, 409);
        return c.json({ ok: true as const });
      })

      // ── GET /api/bots/requests ──
      .get('/requests', async (c) => {
        const user = getAuthUser(c);
        const raw = c.req.query('status');
        const statuses: readonly BotRequestStatus[] = ['pending', 'resolved', 'denied', 'expired', 'canceled'];
        const status = statuses.find((value) => value === raw);
        const requests = await getDb().bots.listRequests(user.id, status ? { status } : {});
        return c.json({ requests: requests.slice(0, 200).map(toRequestView) });
      })

      // ── POST /api/bots/requests/:id — decide ──
      .post('/requests/:id', async (c) => {
        const user = getAuthUser(c);
        const body = await readJson(c);
        try {
          const settled = await decideBotRequest(user.id, c.req.param('id'), body);
          return c.json({ request: toRequestView(settled) });
        } catch (error) {
          if (error instanceof RequestDecisionError) {
            return c.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
          }
          logger.error('[bots] request decision failed', { error: toErrorMessage(error) });
          throw error;
        }
      })

      // ── PATCH /api/bots/:id ──
      .patch('/:id', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const botId = c.req.param('id');
        const body = await readJson(c);
        const owner = await ownerContext(db, user.id);
        const meta = parseVersionMeta(body, user.id);
        if (!meta.ok) return c.json({ error: meta.error, code: 'bot_name_invalid' as const }, 400);
        const updates: {
          name?: string;
          role?: string;
          description?: string;
          instructions?: string;
          avatar?: string;
          model_id?: string | null;
          tools?: string[] | null;
          connectors?: string[] | null;
          max_steps?: number | null;
        } & BotVersionMeta = { ...meta.value };
        if (body.description !== undefined) {
          const description = parseDescription(body.description);
          if (!description.ok) return c.json({ error: description.error, code: 'bot_name_invalid' as const }, 400);
          updates.description = description.value;
        }
        if (body.tools !== undefined) {
          const tools = await parseTools(body.tools, user);
          if (!tools.ok) return c.json({ error: tools.error, code: 'bot_name_invalid' as const }, tools.status);
          updates.tools = tools.value;
        }
        if (body.connectors !== undefined) {
          const connectors = await parseConnectors(body.connectors);
          if (!connectors.ok) return c.json({ error: connectors.error, code: 'bot_name_invalid' as const }, 400);
          updates.connectors = connectors.value;
        }
        if (body.max_steps !== undefined) {
          const maxSteps = parseMaxSteps(body.max_steps);
          if (!maxSteps.ok) return c.json({ error: maxSteps.error, code: 'bot_name_invalid' as const }, 400);
          updates.max_steps = maxSteps.value;
        }
        if (body.name !== undefined) {
          const name = validateBotName(body.name, owner.nickname);
          if (!name.ok) return c.json({ error: name.error, code: name.code as BotFieldErrorCode }, 400);
          updates.name = name.name;
        }
        if (body.role !== undefined) {
          const role = validateBotRole(body.role);
          if (!role.ok) return c.json({ error: role.error, code: role.code as BotFieldErrorCode }, 400);
          updates.role = role.role;
        }
        if (body.instructions !== undefined) {
          const instructions = validateBotInstructions(body.instructions);
          if (!instructions.ok)
            return c.json({ error: instructions.error, code: instructions.code as BotFieldErrorCode }, 400);
          updates.instructions = instructions.instructions;
        }
        if (body.avatar !== undefined) {
          const avatar = parseAvatar(body.avatar);
          if (!avatar.ok) return c.json({ error: 'Invalid avatar', code: 'bot_name_invalid' as const }, 400);
          updates.avatar = JSON.stringify(avatar.value ?? {});
        }
        if (body.model_id !== undefined) {
          const modelId = parseModelId(body.model_id);
          if (!modelId.ok)
            return c.json({ error: 'That model is not available', code: 'bot_name_invalid' as const }, 400);
          updates.model_id = modelId.value ?? null;
        }
        try {
          const bot = await db.bots.updateBot(user.id, botId, updates);
          if (!bot) return c.json({ error: 'Agent not found' }, 404);
          const dms = await dmIndex(db, user.id);
          const dm = dms.get(bot.id) ?? null;
          if (updates.name) {
            if (dm) await db.sessions.updateTitle(dm, bot.name);
            await renameBotFolder(db, bot);
          }
          return c.json({ bot: toBotView(bot, dm) });
        } catch (error) {
          if (error instanceof BotsDomainError && error.code === 'bot_name_taken') {
            return c.json({ error: error.message, code: 'bot_name_taken' as const }, 400);
          }
          throw error;
        }
      })

      // ── DELETE /api/bots/:id — archive ──
      .delete('/:id', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const botId = c.req.param('id');
        // Sprouty is every member's main Bot: it stays (it can be renamed or re-instructed).
        if (isSproutyBot(await db.bots.getBot(user.id, botId)))
          return c.json(
            { error: 'Sprouty is your main Agent and cannot be archived', code: 'bot_protected' as const },
            400,
          );
        const archived = await db.bots.archiveBot(user.id, botId);
        if (!archived) return c.json({ error: 'Agent not found' }, 404);
        // Its own computer goes to sleep (the home stays: it can still be opened and cleaned up).
        void stopComputer(computerRefForBot(user.id, { id: botId }).id, 'admin').catch((error: unknown) =>
          logger.warn('[bots] could not stop an archived Agent’s computer', { error: toErrorMessage(error) }),
        );
        // Its open cards can no longer be acted on: withdraw them so "needs you"
        // does not keep pointing at a Bot that is gone.
        const pending = await db.bots.listRequests(user.id, { status: 'pending' });
        for (const request of pending.filter((row) => row.bot_id === botId)) {
          if (await db.bots.settleRequest(user.id, request.id, 'canceled')) resolveApprovalWaiter(request.id, 'deny');
        }
        await pushAttention(db, user.id);
        return c.json({ ok: true as const });
      })

      // ── GET /api/bots/:id/versions — immutable manifest history (owner; super for support) ──
      .get('/:id/versions', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const botId = c.req.param('id');
        const target =
          (await db.bots.getBot(user.id, botId)) ??
          (user.role === 'super' ? await db.bots.getBotById(botId) : undefined);
        if (!target) return c.json({ error: 'Agent not found' }, 404);
        const versions = await db.bots.listVersions(target.id);
        return c.json({
          bot_id: target.id,
          profile_id: botProfileId(target.id),
          current_version: target.current_version,
          versions: versions.map(toBotVersionView),
        });
      })

      // ── GET /api/bots/:id/files — the Bot's private reference folder and its documents ──
      .get('/:id/files', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const bot = await db.bots.getBot(user.id, c.req.param('id'));
        if (!bot) return c.json({ error: 'Agent not found' }, 404);
        const folder = await db.drive.getBotFolder(bot.id);
        if (!folder) return c.json({ folder: null, docs: [] });
        const folderIds = await kbFolderSubtreeIds(db, folder.id, { visibility: 'private', ownerUserId: user.id });
        const docs = await db.knowledgeBase.list({
          scope: 'shared',
          status: 'published',
          visibility: 'private',
          ownerUserId: user.id,
          folderIds,
          limit: 100,
        });
        return c.json({
          folder: { id: folder.id, name: folder.name, url: `#/knowledge/folder/${folder.id}` },
          docs: docs.map((doc) => ({
            id: doc.id,
            doc_id: doc.doc_id,
            title: doc.title,
            url: entityUrl({ kind: 'kb_doc', id: doc.id, slug: doc.doc_id }),
            updated_at: doc.updated_at,
          })),
        });
      })

      // ── POST /api/bots/:id/files/ensure — create the folder on first use ──
      .post('/:id/files/ensure', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const bot = await db.bots.getBot(user.id, c.req.param('id'));
        if (!bot) return c.json({ error: 'Agent not found' }, 404);
        const folder = await ensureBotFolder(db, bot);
        return c.json({ folder: { id: folder.id, name: folder.name, url: `#/knowledge/folder/${folder.id}` } });
      })

      // ── GET/PUT /api/bots/:id/publication — a public Agent's settings (spec 20261011-agent-first-class P4) ──
      .get('/:id/publication', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const bot = await db.bots.getBot(user.id, c.req.param('id'));
        if (!bot) return c.json({ error: 'Agent not found' }, 404);
        return c.json(await publicationView(db, bot));
      })
      .put('/:id/publication', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const bot = await db.bots.getBot(user.id, c.req.param('id'));
        if (!bot || bot.status !== 'active') return c.json({ error: 'Agent not found' }, 404);
        const body = (await readJson(c)) as BotPublicationWrite;
        try {
          const next = await validatePublicationWrite(db, bot, body);
          const updated = await db.bots.setPublication(user.id, bot.id, {
            visibility: next.visibility,
            published_version: next.publishedVersion,
            publication: JSON.stringify(next.settings),
          });
          if (!updated) return c.json({ error: 'Agent not found' }, 404);
          return c.json(await publicationView(db, updated));
        } catch (error) {
          if (error instanceof PublicationError) {
            return c.json({ error: error.message, code: error.code }, error.code === 'not_found' ? 404 : 400);
          }
          throw error;
        }
      })

      // ── GET /api/bots/:id/feedback — what its users said about its replies (never the conversations) ──
      .get('/:id/feedback', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const bot = await db.bots.getBot(user.id, c.req.param('id'));
        if (!bot) return c.json({ error: 'Agent not found' }, 404);
        const rows = await db.bots.listFeedback(bot.id, 200);
        const nicknames = new Map<string, string>();
        for (const id of new Set(rows.map((row) => row.user_id))) {
          const member = await db.users.getById(id);
          nicknames.set(id, member?.nickname || member?.email || '');
        }
        const feedback: BotFeedbackView[] = rows.map((row) => ({
          id: row.id,
          rating: row.rating === 1 ? 1 : -1,
          comment: row.comment,
          version: row.version,
          user: { id: row.user_id, nickname: nicknames.get(row.user_id) ?? '' },
          created_at: row.created_at,
        }));
        return c.json({ feedback });
      })

      // ── GET /api/bots/:id/usage — model use per day (spec 20261011-agent-first-class P3d) ──
      .get('/:id/usage', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const bot = await db.bots.getBot(user.id, c.req.param('id'));
        if (!bot) return c.json({ error: 'Agent not found' }, 404);
        const raw = Number(c.req.query('days') ?? 30);
        const days = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 90) : 30;
        const since = new Date(Date.now() - days * 86_400_000).toISOString();
        // Its owner sees everyone's use of it (a public Agent's users included, D38).
        const rows = await db.usage.getBotDailyUsage(null, bot.id, since);
        const view: BotUsageView = {
          days: rows,
          totals: rows.reduce(
            (sum, row) => ({
              calls: sum.calls + row.calls,
              input_tokens: sum.input_tokens + row.input_tokens,
              output_tokens: sum.output_tokens + row.output_tokens,
            }),
            { calls: 0, input_tokens: 0, output_tokens: 0 },
          ),
        };
        return c.json(view);
      })

      // ── GET /api/bots/:id/activity — what it did: actions, vault uses, background tasks ──
      .get('/:id/activity', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const bot = await db.bots.getBot(user.id, c.req.param('id'));
        if (!bot) return c.json({ error: 'Agent not found' }, 404);
        const raw = Number(c.req.query('limit') ?? 50);
        const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 200) : 50;
        const [audit, vault, tasks] = await Promise.all([
          db.platform.listAuditEventsForAgent(PLATFORM_ORG_ID, bot.id, user.id, limit),
          db.vault.listAccess(user.id, 200),
          listMemberTaskHistory(db, user.id, MEMBER_TASKS_MAX),
        ]);
        const items: BotActivityItem[] = [
          ...audit.map((event) => ({
            at: event.created_at,
            kind: 'action' as const,
            title: `${event.app_id}.${event.action_id}`,
            outcome: event.result,
            detail: event.record_id ? `${event.entity_id ?? event.app_id} ${event.record_id}` : null,
            // Done for another member (a public Agent, P4): their conversation, which the owner never opens.
            session_id: event.requested_by_user_id && event.requested_by_user_id !== user.id ? null : event.session_id,
          })),
          ...vault
            .filter((row) => row.bot_id === bot.id)
            .map((row) => ({
              at: row.created_at,
              kind: 'vault' as const,
              title: row.action,
              outcome: row.outcome,
              detail: [row.origin, row.item_label].filter(Boolean).join(' · ') || null,
              session_id: row.session_id,
            })),
          ...tasks
            .filter((task) => task.bot_id === bot.id)
            .map((task) => ({
              at: task.created_at,
              kind: 'task' as const,
              title: task.title,
              outcome: task.status,
              detail: task.summary,
              session_id: task.conversation_id,
            })),
        ];
        items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
        return c.json({ activity: items.slice(0, limit) });
      })

      // ── GET /api/bots/:id/memories ──
      .get('/:id/memories', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const bot = await db.bots.getBot(user.id, c.req.param('id'));
        if (!bot) return c.json({ error: 'Agent not found' }, 404);
        const rows = (await db.userMemories.listByUser(user.id)).filter((row) => row.bot_id === bot.id);
        return c.json({
          memories: rows.map((row) => ({
            id: row.id,
            title: row.title,
            content: row.content,
            category: row.category,
            status: row.status,
            pinned: row.pinned,
            created_at: row.created_at,
            last_used_at: row.last_used_at,
          })),
        });
      })

      // ── DELETE /api/bots/:id/memories/:memoryId ──
      .delete('/:id/memories/:memoryId', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const bot = await db.bots.getBot(user.id, c.req.param('id'));
        if (!bot) return c.json({ error: 'Agent not found' }, 404);
        const memoryId = Number(c.req.param('memoryId'));
        const memory = Number.isInteger(memoryId)
          ? await db.userMemories.getOwnedInScope(memoryId, user.id, { botId: bot.id, exact: true })
          : undefined;
        if (!memory) return c.json({ error: 'Memory not found' }, 404);
        await db.userMemories.delete(memory.id, user.id);
        return c.json({ ok: true as const });
      })
  );
}
