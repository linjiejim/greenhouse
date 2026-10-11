/**
 * 飞书里找任意一个 Agent（spec 20261011-agent-first-class P6, D54）。
 *
 * - `/agents`：列出能找的 Agent（自己的 + 对自己开放的公开 Agent）；
 * - 消息以 `@名字` 开头：这串话题改由那个 Agent 在 Agents 引擎里回答——与 MCP 同一个服务
 *   （bots/external/agents.ts）：自己的 Agent 新开任务会话、公开 Agent 用自己和它的私聊，
 *   第一行写「由 飞书 发起」；之后这串话题不带 @ 也继续找它；
 * - 不带 @ 的新话题照旧：主 Agent 走单 Agent 执行器（dispatch.ts），不改现状。
 *
 * Agent 会话是私有的：群里别人在这串话题里发的消息不会进去，回一句说明。确认卡、登录卡只在
 * 应用里出现（D52），这里只说「需要你在 Greenhouse 里确认」并给链接。
 */

import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { flattenForDelivery } from '../../notifications/render.js';
import {
  AgentAccessError,
  askAgent,
  listReachableAgents,
  matchAgentByName,
  type AgentExchange,
  type ReachableAgent,
} from '../../bots/external/agents.js';
import { botsLocale } from '../../bots/engine/copy.js';
import type { FeishuConversationRow } from '@greenhouse/db';

/** 飞书那边有占位卡在等：最多等五分钟，再久就让人去应用里看。 */
export const FEISHU_AGENT_WAIT_MS = 5 * 60_000;
const MAX_REPLY_CHARS = 10_000;

export type FeishuAgentRoute =
  /** `/agents` */
  | { kind: 'list' }
  /** `@名字`（没有正文时 text 为空）。 */
  | { kind: 'address'; agent: ReachableAgent; text: string }
  /** 这串话题已经交给某个 Agent：接着找它。 */
  | { kind: 'continue'; sessionId: string }
  /** 这串话题是别人和他的 Agent 的私密对话。 */
  | { kind: 'private' }
  | { kind: 'default' };

const LIST_COMMAND = /^\/agents?$/i;

/** 这条消息该怎么走。`mapping` 是这串话题现有的映射（可能没有）。 */
export async function routeFeishuMessage(
  db: DatabaseProvider,
  owner: Pick<UserRow, 'id'>,
  mapping: FeishuConversationRow | undefined,
  text: string,
): Promise<FeishuAgentRoute> {
  const trimmed = text.trim();
  if (LIST_COMMAND.test(trimmed)) return { kind: 'list' };
  if (trimmed.startsWith('@')) {
    // 没开 Agents 的账号：`@` 只是普通文字，交给默认路径。
    const match = await matchAgentByName(db, owner.id, trimmed.slice(1)).catch((error: unknown) => {
      if (error instanceof AgentAccessError) return null;
      throw error;
    });
    if (match) return { kind: 'address', agent: match.agent, text: match.rest };
  }
  if (mapping) {
    const session = await db.sessions.getById(mapping.session_id);
    if (session?.channel === 'bots') {
      return session.user_id === owner.id ? { kind: 'continue', sessionId: session.id } : { kind: 'private' };
    }
  }
  return { kind: 'default' };
}

/** `/agents` 的回答。 */
export async function renderAgentList(db: DatabaseProvider, userId: string): Promise<string> {
  let agents: ReachableAgent[];
  try {
    agents = await listReachableAgents(db, userId);
  } catch (error) {
    if (error instanceof AgentAccessError) return '**这个账号还没有开通 Agent**\n\n请联系管理员。';
    throw error;
  }
  const line = (agent: ReachableAgent) => {
    const tag =
      agent.kind === 'main' ? '（主 Agent）' : agent.kind === 'public' ? `（${agent.owner} 的公开 Agent）` : '';
    return `- **${agent.name}**${tag}${agent.role ? ` — ${agent.role}` : ''}`;
  };
  return [
    '**你可以找的 Agent**',
    '',
    ...agents.map(line),
    '',
    '在消息开头写 `@名字` 就会由它回答，这串话题之后也一直找它。不带 @ 的新话题由主 Agent 回答。',
  ].join('\n');
}

/** 一次交流的结果 → 飞书 markdown。 */
export function renderExchange(exchange: AgentExchange): string {
  const speakers = new Set(exchange.replies.map((reply) => reply.agent_id));
  let body = exchange.replies
    .map((reply) => {
      const text = flattenForDelivery(reply.text).trim();
      return speakers.size > 1 ? `**${reply.agent}**：${text}` : text;
    })
    .filter(Boolean)
    .join('\n\n');
  const truncated = body.length > MAX_REPLY_CHARS;
  if (truncated) body = `${body.slice(0, MAX_REPLY_CHARS)}…`;
  const parts = body ? [body] : [];
  if (exchange.notes.length) parts.push(exchange.notes.map((note) => `> ${note}`).join('\n'));
  const open = exchange.url ? `[在 Greenhouse 中打开](${exchange.url})` : '在 Greenhouse 里打开这段对话';
  if (exchange.status === 'needs_you') {
    const what = exchange.needs_you.map((item) => item.summary).filter(Boolean);
    parts.push(`**需要你在 Greenhouse 里确认**${what.length ? `：${what.join('；')}` : ''}\n\n${open}`);
  } else if (exchange.status === 'working') {
    parts.push(`**${exchange.agent.name} 还在处理**，完成后到 Greenhouse 查看：${open}`);
  } else if (!body) {
    parts.push('(没有产生回答)');
  }
  if (exchange.status === 'answered' && exchange.url) {
    parts.push(
      truncated ? `[在 Greenhouse 中查看完整回答](${exchange.url})` : `[在 Greenhouse 中打开](${exchange.url})`,
    );
  }
  parts.push(`— ${exchange.agent.name}`);
  return parts.join('\n\n');
}

/**
 * 把这条消息交给 Agent 并等它回答。新指名（`address`）时这串话题改指向新会话；
 * 接着聊（`continue`）时用已有的会话。
 */
export async function answerThroughAgent(input: {
  db: DatabaseProvider;
  owner: Pick<UserRow, 'id' | 'locale'>;
  route: Extract<FeishuAgentRoute, { kind: 'address' | 'continue' }>;
  text: string;
  /** 新会话建好后让这串话题指向它。 */
  point: (sessionId: string) => Promise<void>;
  waitMs?: number;
}): Promise<string> {
  const { db, owner, route } = input;
  if (!input.text.trim()) {
    return route.kind === 'address'
      ? `想对 **${route.agent.name}** 说什么？在 @${route.agent.name} 后面接着写就好。`
      : '';
  }
  const caller = { label: botsLocale(owner.locale) === 'zh' ? '飞书' : 'Feishu' };
  try {
    const exchange = await askAgent({
      db,
      userId: owner.id,
      ...(route.kind === 'address' ? { agentId: route.agent.id } : { conversationId: route.sessionId }),
      message: input.text,
      caller,
      waitMs: input.waitMs ?? FEISHU_AGENT_WAIT_MS,
    });
    if (route.kind === 'address') await input.point(exchange.conversation_id);
    return renderExchange(exchange);
  } catch (error) {
    if (!(error instanceof AgentAccessError)) throw error;
    if (error.code === 'not_enabled') return '**这个账号还没有开通 Agent**\n\n请联系管理员。';
    if (error.code === 'unavailable') {
      return '**这个 Agent 现在用不了**（被归档或不再对你开放）\n\n发 `/agents` 看看还能找谁，或者新开一个话题。';
    }
    return `**没能交给 Agent**：${error.message}`;
  }
}
