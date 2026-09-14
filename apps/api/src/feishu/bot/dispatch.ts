/**
 * 飞书机器人的一条消息 → 一轮 Agent。
 *
 * 这里只做「协议适配 + 身份 + 会话映射」，真正跑 agent 的是既有的
 * `runAgentInSession`（与定时任务、spawn_session 同一个 runner，spec D7）——
 * 别在这里长出第二条执行路径。
 *
 * 方案见 docs/specs/20260825-feishu-bot-conversation.md。
 */

import { getDb, type DatabaseProvider } from '@greenhouse/db';
import type { UserRole } from '@greenhouse/types/api';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { buildSystemPrompt, selectTools, type ToolRegistry } from '../../agent.js';
import { resolveProfileAsync } from '../../profiles/profile.js';
import { resolveEffectiveTools } from '../../agent-runtime/tool-resolution.js';
import { buildLazyServerTools, LAZY_TOOL_IDS } from '../../agent-runtime/tool-resolution.js';
import { runAgentInSession } from '../../agent-runtime/run-agent.js';
import { resolveMemoryContext } from '../../llm/memory.js';
import { sanitizeUserMessageForPrompt } from '../../chat/user-message.js';
import { flattenRichOutput } from '../../notifications/render.js';
import { FEISHU_PROVIDER } from '../../routes/feishu-oauth.js';
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
}

function settingsUrl(): string {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  return base ? `${base}/#/settings/provider-bindings` : '设置 → Connections';
}

function sessionUrl(sessionId: string): string | null {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  return base ? `${base}/#/chat?session=${encodeURIComponent(sessionId)}` : null;
}

/** 回答上限——超过就截断并让用户去 Web 看全文（spec D10）。 */
const MAX_REPLY_CHARS = 10_000;

/**
 * 处理一条消息，返回该回什么。
 *
 * 每一步都可能「拒绝并给出去路」而不是抛错——IM 里一个静默失败等于机器人坏了。
 */
export async function dispatchFeishuMessage(message: FeishuIncomingMessage, deps: DispatchDeps): Promise<FeishuReply> {
  const db = deps.db ?? getDb();

  // ── 1. 身份：只认绑定，不猜（spec D2）────────────────────
  const binding = await db.providerTokens.findByProviderUserId(FEISHU_PROVIDER, message.open_id);
  if (!binding) {
    return {
      kind: 'guidance',
      content:
        '**你的飞书还没有绑定 Greenhouse 账号**\n\n' +
        `请先用邮箱登录 [Greenhouse](${settingsUrl()})，在 **设置 → Connections** 里绑定飞书，之后就能直接在这里对话。`,
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
  let mapping = await db.feishuBot.findConversation(key);
  if (!mapping) {
    const session = await db.sessions.create(
      message.text.slice(0, 40) || '飞书对话',
      undefined,
      owner.id,
      undefined,
      'feishu',
    );
    mapping = await db.feishuBot.linkConversation({
      feishu_key: key,
      session_id: session.id,
      user_id: owner.id,
      chat_id: message.chat_id,
      chat_type: message.chat_type,
    });
  } else {
    await db.feishuBot.touchConversation(key);
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
      runtimeRunId: null,
    }),
  );

  const memoryBlock = await resolveMemoryContext(owner.id, owner.role as UserRole);
  const systemPrompt = buildSystemPrompt(profile, memoryBlock ? { userInfo: memoryBlock } : undefined);

  // ── 5. 跑既有 runner ─────────────────────────────────────
  const result = await runAgentInSession({
    db,
    sessionId,
    system: systemPrompt,
    prompt,
    modelConfig: profile.model,
    tools,
    maxSteps: profile.max_steps ?? 12,
    ...(profile.tool_choice ? { toolChoice: profile.tool_choice } : {}),
    usageContext: { profileId: profile.id, userId: owner.id, caller: 'feishu-bot' },
  });

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
