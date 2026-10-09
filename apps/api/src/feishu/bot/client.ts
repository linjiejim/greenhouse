/**
 * 飞书机器人的长连接客户端 —— `im.message.receive_v1` 的入口。
 *
 * **为什么是长连接而不是 webhook**：长连接是我们主动连出去的，不需要给飞书开
 * 任何公网入站端点。飞书机房能否 POST 到 `greenhouse.example.com` 始终是个
 * 未知数（OAuth 回调走通只证明**浏览器**能访问），而长连接把这个未知数整个绕
 * 开，同时**事件与卡片回调都收得到**（后台「订阅方式」两个 tab 各自选长连接）。
 * 实测 `ws client ready`，见 spec 的「已实测的事实」。
 *
 * 方案见 docs/specs/20260825-feishu-bot-conversation.md。
 */

import { createHash } from 'node:crypto';
import { getDb, type DatabaseProvider } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { ToolRegistry } from '../../agent.js';
import {
  getFeishuConfig,
  sendCardMarkdown,
  replyCardMarkdown,
  patchCardMarkdown,
  type FeishuSendResult,
} from '../client.js';
import { safeDispatch, type DispatchDeps, type FeishuIncomingMessage } from './dispatch.js';
import { createProgressCard, PROGRESS_START_TEXT } from './progress-card.js';

/**
 * 默认关闭。开一个长连接意味着「任何能给机器人发消息的人都能触发 agent 运行」，
 * 这必须是部署方的显式决定，不能因为配了 FEISHU_APP_ID 就自动生效。
 */
export function isFeishuBotEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FEISHU_BOT_ENABLED === '1' && getFeishuConfig(env) !== null;
}

interface StoppableClient {
  stop?: () => void;
}

let wsClient: StoppableClient | null = null;

/** 测试与优雅关闭用。 */
export function stopFeishuBot(): void {
  try {
    wsClient?.stop?.();
  } catch (err) {
    logger.warn(`[FeishuBot] stop threw: ${toErrorMessage(err)}`);
  }
  wsClient = null;
}

/**
 * 飞书的文本消息 content 是一段 JSON（`{"text":"..."}`）；群里 @机器人 时飞书会
 * 在正文里插入 `@_user_1` 这样的内部标记，直接拿去问模型会把它当成用户的话。
 */
export function parseFeishuText(rawContent: string): string {
  let text = rawContent;
  try {
    const parsed = JSON.parse(rawContent) as { text?: string };
    if (typeof parsed.text === 'string') text = parsed.text;
  } catch {
    /* 非 JSON 就按原样处理 */
  }
  return text
    .replace(/@_user_\d+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The slice of `im.message.receive_v1` the bot reads. */
export interface FeishuMessageEvent {
  sender?: { sender_id?: { open_id?: string } };
  message?: {
    message_id?: string;
    root_id?: string | null;
    parent_id?: string | null;
    thread_id?: string | null;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    create_time?: string;
  };
}

/** How the handler talks to Feishu — the real client by default, fakes in tests. */
export interface FeishuSenders {
  reply: (messageId: string, content: string, opts?: { updatable?: boolean }) => Promise<FeishuSendResult>;
  patch: (messageId: string, content: string) => Promise<FeishuSendResult>;
  dm: (openId: string, content: string) => Promise<FeishuSendResult>;
}

const realSenders: FeishuSenders = { reply: replyCardMarkdown, patch: patchCardMarkdown, dm: sendCardMarkdown };

/**
 * One delivery's identity beyond its message_id: chat + sender + send time +
 * text. Feishu can re-deliver the same message under a NEW message_id, which
 * the message_id receipt alone lets through (spec 20261009 D8). Null when the
 * event carries no create_time — then only the message_id guards.
 */
export function feishuLogicalKey(input: {
  chatId: string;
  openId: string;
  createTime?: string | null;
  content: string;
}): string | null {
  if (!input.createTime) return null;
  return createHash('sha256')
    .update([input.chatId, input.openId, input.createTime, input.content].join('\u0000'))
    .digest('hex');
}

/**
 * Handle one received message: dedup → placeholder card → agent turn with
 * step progress → the answer replaces the card. Every Feishu failure degrades
 * to the previous behaviour (one reply when the turn ends), so the answer is
 * never lost to a card that could not be sent or updated.
 */
export async function handleFeishuMessage(
  data: FeishuMessageEvent,
  deps: { toolRegistry: ToolRegistry; db?: DatabaseProvider; senders?: FeishuSenders } & Pick<DispatchDeps, 'generate'>,
): Promise<void> {
  const db = deps.db ?? getDb();
  const send = deps.senders ?? realSenders;
  const msg = data.message;
  const openId = data.sender?.sender_id?.open_id;
  if (!msg?.message_id || !openId) return;

  // 只处理文本；图片/文件等先明确说不支持，胜过静默不回。
  if (msg.message_type !== 'text') {
    await send.dm(openId, '**目前只支持文字消息**\n\n图片和文件请到 Greenhouse 里发送。');
    return;
  }

  // 先认领再干活：飞书会重投事件，而处理一条消息 = 跑一轮 agent = 花钱
  // 且会回消息（spec D9）。message_id 与逻辑键任一冲突就是「已经有人在处理了」。
  const logicalKey = feishuLogicalKey({
    chatId: msg.chat_id ?? '',
    openId,
    createTime: msg.create_time ?? null,
    content: msg.content ?? '',
  });
  const claimed = await db.feishuBot.claimMessage(msg.message_id, logicalKey);
  if (!claimed) {
    logger.info(`[FeishuBot] duplicate delivery ignored: ${msg.message_id}`);
    return;
  }

  const incoming: FeishuIncomingMessage = {
    message_id: msg.message_id,
    root_id: msg.root_id ?? null,
    parent_id: msg.parent_id ?? null,
    thread_id: msg.thread_id ?? null,
    open_id: openId,
    chat_id: msg.chat_id ?? '',
    chat_type: msg.chat_type === 'group' ? 'group' : 'p2p',
    text: parseFeishuText(msg.content ?? ''),
  };

  // 原路 reply（而不是新发一条）——这样用户的「回复」链和我们的回答在同一条
  // 链上，root_id 才能一路稳定地把会话续下去。先回一张可更新的「正在处理」卡。
  const placeholder = await send.reply(msg.message_id, PROGRESS_START_TEXT, { updatable: true });
  const placeholderId = placeholder.ok ? placeholder.messageId : undefined;
  const progress = placeholderId ? createProgressCard((content) => send.patch(placeholderId, content)) : null;
  if (!placeholderId) {
    logger.warn(`[FeishuBot] placeholder card not sent for ${msg.message_id}: ${placeholder.error ?? 'no message id'}`);
  }

  const reply = await safeDispatch(incoming, {
    db,
    toolRegistry: deps.toolRegistry,
    ...(deps.generate ? { generate: deps.generate } : {}),
    ...(progress ? { onStep: (info) => progress.onStep(info) } : {}),
  });

  if (progress && (await progress.finish(reply.content))) return;
  // The card could not be sent or updated: answer the old way.
  await send.reply(msg.message_id, reply.content);
}

/**
 * 启动长连接。未配置或未启用时**静默跳过**——不是错误，是没开这个功能。
 *
 * 任何失败只记 warn：机器人连不上不该拖垮主 API（与 Mission 预检失败同款姿态）。
 */
export async function initFeishuBot(toolRegistry: ToolRegistry): Promise<void> {
  const config = getFeishuConfig();
  if (!isFeishuBotEnabled() || !config) return;

  try {
    // 动态 import：SDK 只在真正启用时才加载，未开启的部署不为它付启动开销。
    const Lark = await import('@larksuiteoapi/node-sdk');

    const client = new Lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
    });

    client.start({
      eventDispatcher: new Lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          await handleFeishuMessage(data as FeishuMessageEvent, { toolRegistry });
        },
      }),
    });

    wsClient = client as unknown as StoppableClient;
    logger.info('[FeishuBot] long connection started');
  } catch (err) {
    logger.warn(`[FeishuBot] could not start long connection: ${toErrorMessage(err)}`);
  }
}
