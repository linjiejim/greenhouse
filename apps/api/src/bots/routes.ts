/**
 * Bots 路由 — /api/bots（个人助理 Bot、对话、共享笔记、需要你、后台任务）
 *
 * GET    /api/bots                                    — 我的 Bot 列表（bots 仅 active；archived_bots 另列）+ 电脑运行时 + 密码库可用性 + 待处理请求数
 * POST   /api/bots/bootstrap                          — 确保内置主 Bot Sprouty 存在（+ 私聊 + 固定欢迎语）；幂等，每次进入都可调
 * POST   /api/bots                                    — 新建 Bot（模板库模板或自定义；不能建 Sprouty），同时建私聊并写欢迎语
 * GET    /api/bots/conversations                      — 对话列表（按活跃排序，含徽标状态）
 * POST   /api/bots/conversations                      — 1 个 Bot → 它的私聊；2–6 个 → 新群聊
 * GET    /api/bots/conversations/:id                  — 对话详情 + 消息分页（before_seq / limit）+ 本页记忆回执的当前状态
 * PATCH  /api/bots/conversations/:id                  — 改标题 / 群规 / 主理 Bot / Bot 互聊开关
 * POST   /api/bots/conversations/:id/members          — 邀请 Bot（私聊里为客串）
 * DELETE /api/bots/conversations/:id/members/:botId   — 移出 Bot
 * POST   /api/bots/conversations/:id/read             — 标记已读
 * POST   /api/bots/conversations/:id/compact          — 立即整理摘要（有回合在跑时 409）
 * GET    /api/bots/conversations/:id/notes            — 共享笔记列表
 * POST   /api/bots/conversations/:id/notes            — 新建共享笔记
 * PATCH  /api/bots/conversations/:id/notes/:noteId    — 修改共享笔记
 * DELETE /api/bots/conversations/:id/notes/:noteId    — 删除共享笔记
 * GET    /api/bots/conversations/:id/tasks            — 本对话的后台任务
 * POST   /api/bots/tasks/:runId/cancel                — 取消后台任务（Runtime 取消语义）
 * GET    /api/bots/requests                           — 「需要你」请求（?status=pending）
 * POST   /api/bots/requests/:id                       — 处理请求（审批 / 建 Bot / 开始任务 / 登录 / 交还），已处理 409 already_decided、处理中 409 deciding
 * GET    /api/bots/shared                             — 其他成员已发布（pilot / verified）的 Bot，只含发布版本的定义
 * PATCH  /api/bots/:id                                — 修改 Bot 资料（追加一个不可变版本；已共享的回到 draft）
 * DELETE /api/bots/:id                                — 归档 Bot（Sprouty 不可归档：400 bot_protected）
 * GET    /api/bots/:id/versions                       — 不可变版本历史（他人只看到发布版本）
 * POST   /api/bots/:id/lifecycle                      — 生命周期：owner 提交评审 / 撤回 / 归档；super 试点 / 验证 / 驳回 / 暂停 / 退役
 * POST   /api/bots/:id/clone                          — 把一个已发布的 Bot（或自己的）克隆成自己的 Bot（快照，不跟随）
 * GET    /api/bots/:id/memories                       — 该 Bot 的私有记忆
 * DELETE /api/bots/:id/memories/:memoryId             — 删除一条私有记忆
 *
 * 身份类路径（列表、新建、修改、版本、生命周期、克隆、记忆）只要 requireInternal()；
 * 永续对话、请求、后台任务、bootstrap（建私聊）、电脑与密码库还要 requireFeature('bots')
 * （src/index.ts）——`bots` 开关只管永续线程与电脑，不管身份（spec 20261007 D5）。全部按
 * 当前用户 owner 作用域：他人的行与不存在的行一律 404，super 也不能驱动别人的 Bot（共享 Bot
 * 的发布版本与 super 的治理队列除外）。静态路径先于 /:id 注册（Hono 按注册顺序匹配）。
 * 契约：bots/AGENTS.md「HTTP 契约」。
 */

import { Hono } from 'hono';
import { BotsDomainError, getDb, type ConversationWithMembers, type DatabaseProvider } from '@greenhouse/db';
import { avatarConfigSchema, type AvatarConfig } from '@greenhouse/types/profile-manifest';
import {
  BOT_DESCRIPTION_MAX,
  galleryTemplate,
  isSproutyBot,
  type BotConversationDetail,
  type BotLifecycleStatus,
  type BotRequestStatus,
  type BotRiskLevel,
  type BotTemplateKey,
} from '@greenhouse/types/bots';
import { isPublishedLifecycle, type BotGovernanceInput, type BotRow } from '@greenhouse/db';
import { resolveUserTools } from '../agent.js';
import { userHasFeature } from '../auth/features.js';
import { requireSuper } from '../auth/middleware.js';
import { botProfileId, isExecutableBot } from '../profiles/profile.js';
import { getAllToolIds } from '../tools/registry.js';
import { ensureSproutyBot } from './sprouty.js';
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
import { isChatModelAllowed } from '../config/models.js';
import { connectionManager } from '../ws/connection-manager.js';
import { getComputerRuntime } from './computer/index.js';
import { pushAttention, resolveApprovalWaiter } from './engine/approvals.js';
import { botsLocale, copy, type BotsLocale } from './engine/copy.js';
import { compactConversation, digestView, DIGEST_TRIGGER_TOKENS, effectiveDigestUpto } from './engine/digest.js';
import { writeGreeting } from './engine/greeting.js';
import { deliverToConversation } from './engine/inbox.js';
import { nextFreeName, validateBotInstructions, validateBotName, validateBotRole } from './engine/naming.js';
import { decideBotRequest, RequestDecisionError } from './engine/requests.js';
import { cancelBotTask, listConversationTasks } from './engine/tasks.js';
import { estimateRows, readTail } from './engine/transcript.js';
import { NOTE_BODY_MAX, NOTE_TITLE_MAX } from './tools/conversation.js';
import {
  toBotVersionView,
  toBotView,
  toConversationSummary,
  toMessageView,
  toNoteView,
  toRequestView,
  vaultAvailable,
  type BotMemoryState,
  type BotMessageView,
} from './views.js';

const MESSAGES_PAGE_DEFAULT = 60;
const MESSAGES_PAGE_MAX = 200;
const GROUP_TITLE_MAX = 80;
const GROUP_RULES_MAX = 2000;
const REQUESTS_IN_DETAIL = 50;

type BotFieldErrorCode = 'bot_name_invalid' | 'bot_name_taken' | 'bot_limit';

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

async function ownerContext(db: DatabaseProvider, userId: string) {
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

const MAX_STEPS_LIMIT = 50;

function parseMaxSteps(raw: unknown): { ok: true; value: number | null | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_STEPS_LIMIT) {
    return { ok: false, error: `max_steps must be an integer between 1 and ${MAX_STEPS_LIMIT}` };
  }
  return { ok: true, value: raw };
}

const RISK_LEVELS: readonly BotRiskLevel[] = ['low', 'medium', 'high'];

/** Governance metadata (versioned with the manifest); every field optional. */
function parseGovernance(
  body: Record<string, unknown>,
  actorId: string,
): { ok: true; value: BotGovernanceInput } | { ok: false; error: string } {
  const value: BotGovernanceInput = { created_by: actorId };
  const text = (key: 'purpose' | 'audience' | 'owner_backup_user_id' | 'review_due_at', max: number) => {
    const raw = body[key];
    if (raw === undefined) return true;
    if (raw === null || raw === '') {
      value[key] = null;
      return true;
    }
    if (typeof raw !== 'string' || raw.length > max) return false;
    value[key] = raw.trim();
    return true;
  };
  if (
    !text('purpose', 500) ||
    !text('audience', 500) ||
    !text('owner_backup_user_id', 64) ||
    !text('review_due_at', 64)
  ) {
    return { ok: false, error: 'Invalid governance field' };
  }
  if (body.risk_level !== undefined) {
    if (!RISK_LEVELS.includes(body.risk_level as BotRiskLevel)) {
      return { ok: false, error: 'risk_level must be low, medium, or high' };
    }
    value.risk_level = body.risk_level as BotRiskLevel;
  }
  if (body.budget_policy !== undefined) {
    if (!body.budget_policy || typeof body.budget_policy !== 'object' || Array.isArray(body.budget_policy)) {
      return { ok: false, error: 'budget_policy must be an object' };
    }
    value.budget_policy = body.budget_policy as Record<string, unknown>;
  }
  if (body.eval_refs !== undefined) {
    if (!Array.isArray(body.eval_refs)) return { ok: false, error: 'eval_refs must be an array' };
    value.eval_refs = body.eval_refs;
  }
  if (body.change_log !== undefined) {
    if (typeof body.change_log !== 'string' || body.change_log.length > 500) {
      return { ok: false, error: 'change_log must be text' };
    }
    value.change_log = body.change_log;
  }
  return { ok: true, value };
}

const LIFECYCLE_STATUSES: readonly BotLifecycleStatus[] = [
  'draft',
  'review',
  'pilot',
  'verified',
  'rejected',
  'suspended',
  'deprecated',
  'archived',
];
const OWNER_LIFECYCLE_STATUSES: readonly BotLifecycleStatus[] = ['draft', 'review', 'archived'];

/** Whether this member may keep Bots conversations (the `bots` flag gates threads, not identity). */
async function conversationsEnabled(user: Pick<AuthUser, 'id' | 'role'>): Promise<boolean> {
  return userHasFeature(user.id, user.role, 'bots');
}

async function conversationDetail(
  db: DatabaseProvider,
  userId: string,
  conversation: ConversationWithMembers,
  locale: BotsLocale,
): Promise<BotConversationDetail> {
  const sessionId = conversation.session_id;
  const [latest, requests, notes, allBots, tail] = await Promise.all([
    db.bots.latestMessages([sessionId]),
    db.bots.listRequests(userId, { sessionId }),
    db.bots.listNotes(sessionId),
    db.bots.listBots(userId, { includeArchived: true }),
    readTail(db, sessionId, effectiveDigestUpto(conversation)),
  ]);
  const botNames = new Map(allBots.map((bot) => [bot.id, bot.name]));
  const pending = requests.filter((request) => request.status === 'pending').length;
  const summary = toConversationSummary(conversation, {
    lastMessage: latest.get(sessionId) ?? null,
    pendingRequests: pending,
    working: Boolean(chatRunRegistry.getActive(sessionId)),
  });
  return {
    ...summary,
    description: conversation.description,
    allow_bot_chat: conversation.allow_bot_chat,
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

function domainStatus(error: BotsDomainError): 400 | 404 | 409 {
  switch (error.code) {
    case 'bot_not_found':
    case 'conversation_not_found':
    case 'note_not_found':
      return 404;
    case 'already_member':
      return 409;
    default:
      return 400;
  }
}

function notifyConversation(userId: string, sessionId: string): void {
  connectionManager.sendToUser(userId, { type: 'bots:conversation', sessionId });
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
        // Archived Bots ride along separately: their DMs stay readable and old
        // messages, audit rows and receipts still need a name for them.
        return c.json({
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

      // ── GET /api/bots/shared — Bots other members published (their reviewed version) ──
      .get('/shared', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const shared = await db.bots.listShared(user.id);
        const views: Array<ReturnType<typeof toBotView>> = [];
        for (const bot of shared) {
          const version = bot.published_version ? await db.bots.getVersion(bot.id, bot.published_version) : undefined;
          if (!version) continue;
          // Show the published manifest, never the owner's newer draft.
          views.push(
            toBotView(
              {
                ...bot,
                name: version.name,
                role: version.role,
                description: version.description,
                instructions: version.instructions,
                avatar: version.avatar,
                model_id: version.model_id,
                tools: version.tools,
                max_steps: version.max_steps,
              },
              null,
            ),
          );
        }
        const owners = await Promise.all([...new Set(views.map((v) => v.user_id))].map((id) => db.users.getById(id)));
        const nickname = new Map(owners.filter(Boolean).map((u) => [u!.id, u!.nickname]));
        return c.json({ bots: views.map((v) => ({ ...v, owner_nickname: nickname.get(v.user_id) ?? '' })) });
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
        const maxSteps = parseMaxSteps(body.max_steps);
        if (!maxSteps.ok) return c.json({ error: maxSteps.error, code: 'bot_name_invalid' as const }, 400);
        const governance = parseGovernance(body, user.id);
        if (!governance.ok) return c.json({ error: governance.error, code: 'bot_name_invalid' as const }, 400);

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
            max_steps: maxSteps.value ?? null,
            template_key: template?.key ?? null,
            ...governance.value,
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

      // ── GET /api/bots/conversations ──
      .get('/conversations', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const [conversations, pending] = await Promise.all([
          db.bots.listConversations(user.id),
          db.bots.listRequests(user.id, { status: 'pending' }),
        ]);
        const latest = await db.bots.latestMessages(conversations.map((conversation) => conversation.session_id));
        const pendingBySession = new Map<string, number>();
        for (const request of pending) {
          pendingBySession.set(request.session_id, (pendingBySession.get(request.session_id) ?? 0) + 1);
        }
        return c.json({
          conversations: conversations.map((conversation) =>
            toConversationSummary(conversation, {
              lastMessage: latest.get(conversation.session_id) ?? null,
              pendingRequests: pendingBySession.get(conversation.session_id) ?? 0,
              working: Boolean(chatRunRegistry.getActive(conversation.session_id)),
            }),
          ),
        });
      })

      // ── POST /api/bots/conversations — DM (1 Bot) or new group (2–6) ──
      .post('/conversations', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const body = await readJson(c);
        const botIds = Array.isArray(body.bot_ids) ? body.bot_ids : null;
        if (!botIds || botIds.length === 0 || botIds.length > 6 || botIds.some((id) => typeof id !== 'string')) {
          return c.json({ error: 'bot_ids must list 1–6 Bots' }, 400);
        }
        const ids = [...new Set(botIds as string[])];
        const title = typeof body.title === 'string' ? body.title.trim().slice(0, GROUP_TITLE_MAX) : null;
        const owner = await ownerContext(db, user.id);
        try {
          let conversation: ConversationWithMembers;
          if (ids.length === 1) {
            conversation = await db.bots.ensureDirectConversation(user.id, ids[0]!);
            const bot = await db.bots.getBot(user.id, ids[0]!);
            if (bot) await writeGreeting(db, conversation.session_id, bot);
          } else {
            conversation = await db.bots.createGroupConversation({
              user_id: user.id,
              bot_ids: ids,
              title: title || null,
            });
          }
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
        return c.json({
          conversation: detail,
          messages,
          has_more: page.has_more,
          ...(memoryStates ? { memory_states: memoryStates } : {}),
        });
      })

      // ── PATCH /api/bots/conversations/:id ──
      .patch('/conversations/:id', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const sessionId = c.req.param('id');
        const conversation = await db.bots.getConversation(user.id, sessionId);
        if (!conversation) return c.json({ error: 'Conversation not found' }, 404);
        const body = await readJson(c);
        const updates: { title?: string | null; description?: string; lead_bot_id?: string; allow_bot_chat?: boolean } =
          {};
        if (body.title !== undefined) {
          if (conversation.kind === 'direct')
            return c.json({ error: 'A direct conversation is named after its Bot' }, 400);
          if (body.title !== null && typeof body.title !== 'string')
            return c.json({ error: 'title must be text' }, 400);
          updates.title = typeof body.title === 'string' ? body.title.trim().slice(0, GROUP_TITLE_MAX) || null : null;
        }
        if (body.description !== undefined) {
          if (typeof body.description !== 'string' || body.description.length > GROUP_RULES_MAX) {
            return c.json({ error: `Group rules have at most ${GROUP_RULES_MAX} characters` }, 400);
          }
          updates.description = body.description.trim();
        }
        if (body.lead_bot_id !== undefined) {
          if (conversation.kind === 'direct')
            return c.json({ error: 'A direct conversation is always led by its Bot' }, 400);
          if (typeof body.lead_bot_id !== 'string') return c.json({ error: 'lead_bot_id must be a Bot id' }, 400);
          updates.lead_bot_id = body.lead_bot_id;
        }
        if (body.allow_bot_chat !== undefined) {
          if (typeof body.allow_bot_chat !== 'boolean')
            return c.json({ error: 'allow_bot_chat must be a boolean' }, 400);
          updates.allow_bot_chat = body.allow_bot_chat;
        }
        try {
          await db.bots.updateConversation(user.id, sessionId, updates);
        } catch (error) {
          if (error instanceof BotsDomainError)
            return c.json({ error: error.message, code: error.code }, domainStatus(error));
          throw error;
        }
        const fresh = await db.bots.getConversation(user.id, sessionId);
        if (!fresh) return c.json({ error: 'Conversation not found' }, 404);
        const owner = await ownerContext(db, user.id);
        notifyConversation(user.id, sessionId);
        return c.json({ conversation: await conversationDetail(db, user.id, fresh, owner.locale) });
      })

      // ── POST /api/bots/conversations/:id/members ──
      .post('/conversations/:id/members', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const sessionId = c.req.param('id');
        const body = await readJson(c);
        if (typeof body.bot_id !== 'string') return c.json({ error: 'bot_id is required' }, 400);
        const owner = await ownerContext(db, user.id);
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
        if (!removed) return c.json({ error: 'That Bot is not in this conversation' }, 404);
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

      // ── POST /api/bots/conversations/:id/read ──
      .post('/conversations/:id/read', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const conversation = await db.bots.getConversation(user.id, c.req.param('id'));
        if (!conversation) return c.json({ error: 'Conversation not found' }, 404);
        await db.bots.markRead(user.id, conversation.session_id);
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
          return c.json({ error: 'A Bot is replying — try again when it has finished' }, 409);
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
          return c.json({ error: 'A Bot is replying — try again when it has finished' }, 409);
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
        const governance = parseGovernance(body, user.id);
        if (!governance.ok) return c.json({ error: governance.error, code: 'bot_name_invalid' as const }, 400);
        const updates: {
          name?: string;
          role?: string;
          description?: string;
          instructions?: string;
          avatar?: string;
          model_id?: string | null;
          tools?: string[] | null;
          max_steps?: number | null;
        } & BotGovernanceInput = { ...governance.value };
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
          if (!bot) return c.json({ error: 'Bot not found' }, 404);
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
            { error: 'Sprouty is your main Bot and cannot be archived', code: 'bot_protected' as const },
            400,
          );
        const archived = await db.bots.archiveBot(user.id, botId);
        if (!archived) return c.json({ error: 'Bot not found' }, 404);
        // Its open cards can no longer be acted on: withdraw them so "needs you"
        // does not keep pointing at a Bot that is gone.
        const pending = await db.bots.listRequests(user.id, { status: 'pending' });
        for (const request of pending.filter((row) => row.bot_id === botId)) {
          if (await db.bots.settleRequest(user.id, request.id, 'canceled')) resolveApprovalWaiter(request.id, 'deny');
        }
        await pushAttention(db, user.id);
        return c.json({ ok: true as const });
      })

      // ── GET /api/bots/:id/versions — immutable manifest history ──
      .get('/:id/versions', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const botId = c.req.param('id');
        const own = await db.bots.getBot(user.id, botId);
        const bot = own ?? (user.role === 'super' ? await db.bots.getBotById(botId) : undefined);
        const foreign = !own ? await db.bots.getBotById(botId) : undefined;
        const target = bot ?? foreign;
        if (!target) return c.json({ error: 'Bot not found' }, 404);
        const owns = Boolean(own) || user.role === 'super';
        // Others only ever see the published manifest of a shared Bot.
        if (!owns && !(target.is_shared && isPublishedLifecycle(target.lifecycle_status) && target.published_version)) {
          return c.json({ error: 'Bot not found' }, 404);
        }
        const versions = await db.bots.listVersions(target.id);
        const visible = owns ? versions : versions.filter((v) => v.version === target.published_version);
        return c.json({
          bot_id: target.id,
          profile_id: botProfileId(target.id),
          current_version: target.current_version,
          published_version: target.published_version,
          versions: visible.map(toBotVersionView),
        });
      })

      // ── POST /api/bots/:id/lifecycle — governed transition ──
      .post('/:id/lifecycle', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const botId = c.req.param('id');
        const bot = user.role === 'super' ? await db.bots.getBotById(botId) : await db.bots.getBot(user.id, botId);
        if (!bot) return c.json({ error: 'Bot not found' }, 404);
        if (isSproutyBot(bot)) {
          return c.json(
            { error: 'Your main Bot is personal and cannot be shared', code: 'bot_protected' as const },
            400,
          );
        }
        const body = await readJson(c);
        const status = body.status as BotLifecycleStatus;
        if (!LIFECYCLE_STATUSES.includes(status)) return c.json({ error: 'Invalid lifecycle status' }, 400);
        if (user.role !== 'super' && !OWNER_LIFECYCLE_STATUSES.includes(status)) {
          return c.json({ error: 'Only super can pilot, verify, reject, suspend, or deprecate Bots' }, 403);
        }
        try {
          const updated = await db.bots.transitionLifecycle(bot.id, {
            status,
            actor_user_id: user.id,
            note: typeof body.note === 'string' ? body.note.trim().slice(0, 500) || null : null,
            publish_version: Number.isInteger(body.publish_version) ? (body.publish_version as number) : null,
            next_review_at: typeof body.next_review_at === 'string' ? body.next_review_at : null,
          });
          if (!updated) return c.json({ error: 'Bot not found' }, 404);
          logger.info(
            `[bots] lifecycle ${bot.lifecycle_status} -> ${updated.lifecycle_status}: ${bot.id} by ${user.id}`,
          );
          const dms = await dmIndex(db, updated.user_id);
          return c.json({ bot: toBotView(updated, dms.get(updated.id) ?? null) });
        } catch (error) {
          return c.json({ error: toErrorMessage(error), code: 'lifecycle' as const }, 409);
        }
      })

      // ── POST /api/bots/:id/clone — my own copy of a published (or my own) Bot; a snapshot, not a reference ──
      .post('/:id/clone', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const botId = c.req.param('id');
        const owner = await ownerContext(db, user.id);
        const source = await db.bots.getBotById(botId);
        if (!source) return c.json({ error: 'Bot not found' }, 404);
        const owns = source.user_id === user.id || user.role === 'super';
        let manifest: Pick<
          BotRow,
          'name' | 'role' | 'description' | 'instructions' | 'avatar' | 'model_id' | 'tools' | 'max_steps'
        > = source;
        let sourceRef = botProfileId(source.id, source.current_version);
        if (!owns) {
          if (!(source.is_shared && isPublishedLifecycle(source.lifecycle_status) && source.published_version)) {
            return c.json({ error: 'Bot not found' }, 404);
          }
          const published = await db.bots.getVersion(source.id, source.published_version);
          if (!published) return c.json({ error: 'Bot not found' }, 404);
          manifest = published;
          sourceRef = botProfileId(source.id, source.published_version);
        } else if (!isExecutableBot(source) && source.status !== 'archived') {
          return c.json({ error: 'This Bot cannot be cloned' }, 409);
        }
        const body = await readJson(c);
        const active = await db.bots.listBots(user.id);
        const taken = new Set([...active.map((bot) => bot.name_key), botNameKey(owner.nickname)].filter(Boolean));
        const rawName =
          typeof body.name === 'string' && body.name.trim() ? body.name : nextFreeName(manifest.name, taken);
        const name = validateBotName(rawName, owner.nickname);
        if (!name.ok) return c.json({ error: name.error, code: name.code as BotFieldErrorCode }, 400);
        // A clone may only hold tools its new owner has (the filter is intersected again at run time).
        const tools = await parseTools(manifest.tools == null ? null : safeJsonParse(manifest.tools, []), user);
        const narrowed = tools.ok ? tools.value : null;
        try {
          const bot = await db.bots.createBot({
            user_id: user.id,
            name: name.name,
            role: manifest.role,
            description: manifest.description,
            instructions: manifest.instructions,
            avatar: manifest.avatar,
            model_id: manifest.model_id,
            tools: narrowed ?? null,
            max_steps: manifest.max_steps,
            forked_from: sourceRef,
            change_log: `Cloned from ${sourceRef}`,
            created_by: user.id,
          });
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

      // ── GET /api/bots/:id/files — the Bot's private reference folder and its documents ──
      .get('/:id/files', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const bot = await db.bots.getBot(user.id, c.req.param('id'));
        if (!bot) return c.json({ error: 'Bot not found' }, 404);
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
        if (!bot) return c.json({ error: 'Bot not found' }, 404);
        const folder = await ensureBotFolder(db, bot);
        return c.json({ folder: { id: folder.id, name: folder.name, url: `#/knowledge/folder/${folder.id}` } });
      })

      // ── GET /api/bots/:id/memories ──
      .get('/:id/memories', async (c) => {
        const user = getAuthUser(c);
        const db = getDb();
        const bot = await db.bots.getBot(user.id, c.req.param('id'));
        if (!bot) return c.json({ error: 'Bot not found' }, 404);
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
        if (!bot) return c.json({ error: 'Bot not found' }, 404);
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

/**
 * Super's governance queue — /api/admin/bots (mounted behind requireSuper()).
 * Every Bot that entered the review lifecycle; personal drafts are not listed.
 */
export function createBotsAdminRoutes() {
  return new Hono<AppEnv>().use('*', requireSuper()).get('/review', async (c) => {
    const db = getDb();
    const rows = await db.bots.listGovernanceQueue();
    const owners = await Promise.all([...new Set(rows.map((bot) => bot.user_id))].map((id) => db.users.getById(id)));
    const nickname = new Map(owners.filter(Boolean).map((u) => [u!.id, u!.nickname]));
    return c.json({
      bots: rows.map((bot) => ({ ...toBotView(bot, null), owner_nickname: nickname.get(bot.user_id) ?? '' })),
    });
  });
}
