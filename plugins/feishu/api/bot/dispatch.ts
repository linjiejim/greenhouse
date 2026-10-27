import { services } from '../services.js';
/**
 * 飞书机器人的一条消息 → 一轮 Agent。
 *
 * 这里只做「协议适配 + 身份 + 会话映射」，真正跑 agent 的是既有的
 * `runAgentInSession`（与定时任务同一个 runner，spec D7）——
 * 别在这里长出第二条执行路径。
 *
 * 方案见 docs/specs/20260825-feishu-bot-conversation.md。
 */

import { getDb, readSessionDigest, type DatabaseProvider } from '@greenhouse/api/extension-kit';
import { resolveHistoryBudget, windowMessagesByBudget } from '@greenhouse/api/extension-kit';
import type { UserRole } from '@greenhouse/types/api';
import { CLIENT_ROUTES, clientRouteUrl } from '@greenhouse/types/client-routes';
import { logger } from '@greenhouse/api/extension-kit';
import { toErrorMessage } from '@greenhouse/api/extension-kit';
import { channelAgentRuntime, type ToolRegistry } from '@greenhouse/api/extension-kit';
import { resolveProfileAsync } from '@greenhouse/api/extension-kit';
import { runAgentTurn, type AgentGenerate, type HeadlessMessage } from '@greenhouse/api/extension-kit';
import { resolveExtensionPromptContext } from '@greenhouse/api/extension-kit';
import { sanitizeChatMessagesForPrompt, sanitizeUserMessageForPrompt } from '@greenhouse/api/extension-kit';
import { formatDigestSection, scheduleDigestFold } from '@greenhouse/api/extension-kit';
import { flattenRichOutput } from '@greenhouse/api/extension-kit';
import { FEISHU_PROVIDER } from '../oauth.js';
import { renderAskUserFromEvidence } from './ask-user.js';
import { feishuConversationKey, filterFeishuToolIds, groupVisibilityFooter } from './conversation-key.js';
import type { FeishuThreadRefs } from './conversation-key.js';

/** 一条飞书消息里我们关心的全部内容。 */
export interface FeishuIncomingMessage extends FeishuThreadRefs {
  open_id: string;
  chat_id: string;
  chat_type: 'p2p' | 'group';
  /** 已经剥掉 @机器人 标记的纯文本。 */
  text: string;
}

/** 回给飞书的东西——由调用方决定用 reply 还是 create 发出去。 */
export type FeishuReply =
  | { kind: 'markdown'; content: string }
  /** 未绑定/被拒：文案 + 一个指向 Greenhouse 的深链。 */
  | { kind: 'guidance'; content: string };

export interface DispatchDeps {
  db?: DatabaseProvider;
  toolRegistry: ToolRegistry;
  /** Test seam — forwarded to runAgentInSession (defaults to the real loop). */
  generate?: AgentGenerate;
  /** Test seam — the post-turn rolling-digest fold (defaults to `scheduleDigestFold`). */
  scheduleFold?: typeof scheduleDigestFold;
}

function settingsUrl(): string {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  return base ? clientRouteUrl(base, CLIENT_ROUTES.connections) : '「我」→ 连接';
}

function sessionUrl(sessionId: string): string | null {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  return base ? `${base}/#/chat?session=${encodeURIComponent(sessionId)}` : null;
}

/** 回答上限——超过就截断并让用户去 Web 看全文（spec D10）。 */
const MAX_REPLY_CHARS = 10_000;

/**
 * 这串对话之前的轮次——「回复即延续」要让模型真的看见上文（spec D1 承诺的多轮，
 * 2026-10-09 之前 runner 只发当前一条，延续只延续了 session、没延续上下文）。
 *
 * 与 chat 同一个投影与预算：`sanitizeChatMessagesForPrompt` 只改模型视图不改转录，
 * `resolveHistoryBudget` → `windowMessagesByBudget` 按 token 开窗、丢最旧的整条。
 * 刚落库的当前这条不算历史（runner 自己会把 prompt 接在最后）。
 *
 * 有滚动摘要时与 chat 同一口径：`seq ≤ digest_upto_seq` 的消息不再回放，由系统
 * prompt 末尾的摘要段代替（见 chat/digest.ts）。
 */
async function loadPriorMessages(
  db: DatabaseProvider,
  sessionId: string,
  prompt: string,
  modelId: string | undefined,
  afterSeq: number | null,
): Promise<HeadlessMessage[]> {
  const transcript = await db.sessions.buildChatMessages(sessionId, { afterSeq });
  const tail = transcript.at(-1);
  const prior = tail && tail.role === 'user' && tail.content === prompt ? transcript.slice(0, -1) : transcript;
  if (prior.length === 0) return [];

  // buildChatMessages already keeps only user/assistant rows; the filter just
  // tells the type system so.
  const projected = sanitizeChatMessagesForPrompt(
    prior.flatMap((m): HeadlessMessage[] =>
      m.role === 'user' || m.role === 'assistant'
        ? [{ role: m.role, content: m.content, ...(m.created_at ? { created_at: m.created_at } : {}) }]
        : [],
    ),
  );
  const budget = resolveHistoryBudget(modelId);
  const window = windowMessagesByBudget<HeadlessMessage>([...projected, { role: 'user', content: prompt }], budget);
  if (window.dropped > 0) {
    logger.info('[FeishuBot] history window dropped oldest messages', {
      sessionId,
      dropped: window.dropped,
      kept: window.messages.length - 1,
      estimatedTokens: window.estimatedTokens,
      budget,
    });
  }
  return window.messages.slice(0, -1);
}

/**
 * 处理一条消息，返回该回什么。
 *
 * 每一步都可能「拒绝并给出去路」而不是抛错——IM 里一个静默失败等于机器人坏了。
 */
export async function dispatchFeishuMessage(message: FeishuIncomingMessage, deps: DispatchDeps): Promise<FeishuReply> {
  const db = deps.db ?? getDb();
  const { buildSystemPrompt, selectTools, resolveEffectiveTools, buildLazyServerTools, LAZY_TOOL_IDS } =
    await channelAgentRuntime();

  // ── 1. 身份：只认绑定，不猜（spec D2）────────────────────
  const binding = await db.providerTokens.findByProviderUserId(FEISHU_PROVIDER, message.open_id);
  if (!binding) {
    return {
      kind: 'guidance',
      content:
        '**你的飞书还没有绑定 Greenhouse 账号**\n\n' +
        `请先用邮箱登录 [Greenhouse](${settingsUrl()})，在 **「我」→ 连接** 里绑定飞书，之后就能直接在这里对话。`,
    };
  }

  // 每条消息都重新读账号——绑定之后被禁用/降级的必须立刻失效。
  const owner = await db.users.getById(binding.user_id);
  if (!owner || owner.status !== 'active' || (owner.role !== 'team' && owner.role !== 'super')) {
    return {
      kind: 'guidance',
      content: '**这个账号当前无法使用 Greenhouse**\n\n请联系管理员。',
    };
  }

  // ── 2. 会话映射（spec D1）────────────────────────────────
  const key = feishuConversationKey(message);
  let mapping = await services(db).feishuBot.findConversation(key);
  if (!mapping) {
    const session = await db.sessions.create(
      message.text.slice(0, 40) || '飞书对话',
      undefined,
      owner.id,
      undefined,
      'feishu',
    );
    mapping = await services(db).feishuBot.linkConversation({
      feishu_key: key,
      session_id: session.id,
      user_id: owner.id,
      chat_id: message.chat_id,
      chat_type: message.chat_type,
    });
  } else {
    await services(db).feishuBot.touchConversation(key);
  }
  // 并发下 linkConversation 可能返回别人先建的行——以它为准。
  const sessionId = mapping.session_id;

  // ── 3. 落 user 消息（runner 要求 tail 是它，见 run-agent 的 CAS）──
  const prompt = sanitizeUserMessageForPrompt(message.text);
  await db.sessions.addMessage({ session_id: sessionId, role: 'user', content: prompt });

  // ── 4. 工具面：用户自己的权限，再按飞书面收窄（spec D4/D6）──
  const profile = await resolveProfileAsync(undefined, db);
  const { effectiveTools } = await resolveEffectiveTools({
    userId: owner.id,
    userRole: owner.role,
    profile,
    profileId: profile.id,
  });
  const toolIds = filterFeishuToolIds(effectiveTools);
  const tools = selectTools(
    deps.toolRegistry,
    toolIds.filter((id) => !LAZY_TOOL_IDS.has(id)),
  );
  Object.assign(
    tools,
    buildLazyServerTools(db, toolIds, {
      userId: owner.id,
      userRole: owner.role,
      sessionId,
      profileId: profile.id,
      toolRegistry: deps.toolRegistry,
      // 对面有真人在等回答——这不是无人值守（spec D6）。
      unattended: false,
    }),
  );

  const memoryBlock = await resolveExtensionPromptContext(owner.id, owner.role as UserRole, Object.keys(tools));
  let systemPrompt = buildSystemPrompt(profile, memoryBlock ? { userInfo: memoryBlock } : undefined);

  // ── 5. 跑既有 runner（带上这串对话的历史）────────────────
  // 只给会话的主人回放历史。群里任何绑定成员都能回复同一条链、落进同一个会话，
  // 而主人可能在 Web 上接着聊过——那些轮次从没发到群里，不能经别人的提问带进群。
  // 滚动摘要是同一份历史的另一种形态，同一条规则：只给主人。
  const isOwner = mapping.user_id === owner.id;
  const digest = isOwner ? readSessionDigest(await db.sessions.getById(sessionId)) : null;
  if (digest) {
    systemPrompt += formatDigestSection(digest.text, { canSearch: 'session_query' in tools });
  }
  const priorMessages = isOwner
    ? await loadPriorMessages(db, sessionId, prompt, profile.model.id, digest?.uptoSeq ?? null)
    : [];
  const result = await runAgentTurn({
    db,
    sessionId,
    system: systemPrompt,
    prompt,
    priorMessages,
    modelConfig: profile.model,
    tools,
    maxSteps: profile.max_steps ?? 12,
    ...(profile.tool_choice ? { toolChoice: profile.tool_choice } : {}),
    toolCallClient: 'feishu',
    usageContext: { profileId: profile.id, userId: owner.id, caller: 'feishu-bot' },
    ...(deps.generate ? { generate: deps.generate } : {}),
  });

  // 回答已落库：按 chat 同一规则在后台折叠更早的轮次（不阻塞这次回复）。
  // 只在主人发言时折叠——摘要的花费记在触发它的人头上，而它服务的是主人的历史。
  if (isOwner)
    void (deps.scheduleFold ?? scheduleDigestFold)({ sessionId, userId: owner.id, modelId: profile.model.id, db });

  // ── 6. 呈现：富块围栏拍平成飞书能渲染的 markdown（spec D10）──
  let content = flattenRichOutput(result.text ?? '').trim();

  // `ask_user` 的问题住 artifact、不进正文，所以必须从工具证据里取出来渲染，
  // 否则用户只看到一句引导语、却不知道被问了什么（spec D11）。
  const questions = renderAskUserFromEvidence(result.toolEvidence);

  // ⚠️ 截断只作用于**正文**，提问永远保留。反过来（先拼再截）会让一次长回答
  // 把结尾的问题整段吃掉——用户被问了却看不见，与附件 fence 被
  // `sanitizeForPrompt` 截断吃掉是同一个形状的 bug。
  if (content.length > MAX_REPLY_CHARS) content = `${content.slice(0, MAX_REPLY_CHARS)}…`;
  const truncated = content.endsWith('…');
  if (questions) content = content ? `${content}\n\n${questions}` : questions;
  if (!content) content = '(没有产生回答)';

  const link = sessionUrl(sessionId);
  if (link) {
    content += truncated ? `\n\n[在 Greenhouse 中查看完整回答](${link})` : `\n\n[在 Greenhouse 中打开](${link})`;
  }
  // 群里让「谁的权限、给谁看」每次都可见（spec D3）。
  if (message.chat_type === 'group') {
    content += groupVisibilityFooter(owner.nickname || owner.email);
  }

  logger.info(`[FeishuBot] answered ${message.message_id} in session ${sessionId} (${result.durationMs}ms)`);
  return { kind: 'markdown', content };
}

/** 顶层保护：任何异常都要变成一句用户读得懂的话，而不是静默。 */
export async function safeDispatch(message: FeishuIncomingMessage, deps: DispatchDeps): Promise<FeishuReply> {
  try {
    return await dispatchFeishuMessage(message, deps);
  } catch (err) {
    logger.error(`[FeishuBot] dispatch failed for ${message.message_id}: ${toErrorMessage(err)}`);
    return { kind: 'guidance', content: '**出错了，请重试**\n\n如果反复失败，请到 Greenhouse 里继续这次对话。' };
  }
}
