/**
 * A Bot's first words — a fixed, server-written greeting (no model call).
 *
 * Written when a Bot's DM is created (bootstrap, "New Bot", a confirmed
 * proposal). It must be instant and must never promise what this deployment
 * cannot do, so every capability line is derived from the real state: the
 * computer runtime, the vault key, the background-task driver, the member's
 * memory flag. The composer starters (chips) come from the template on the
 * client; the greeting stays prose.
 */

import type { BotRow, DatabaseProvider } from '@greenhouse/db';
import type { ComputerRuntimeView } from '@greenhouse/types/bots';
import { botTemplate } from '@greenhouse/types/bots';
import type { MessageRow } from '@greenhouse/types/session';
import { userHasFeature } from '../../auth/features.js';
import { runtimeDriverEnabled } from '../../trusted-execution/kill-switches.js';
import { getComputerRuntime } from '../computer/index.js';
import { vaultAvailable } from '../views.js';
import { botsLocale, type BotsLocale } from './copy.js';

export interface GreetingFacts {
  locale: BotsLocale;
  computer: ComputerRuntimeView;
  vault: boolean;
  backgroundTasks: boolean;
  memory: { enabled: boolean; count: number };
}

export function buildGreeting(bot: Pick<BotRow, 'name' | 'role' | 'template_key'>, facts: GreetingFacts): string {
  const zh = facts.locale === 'zh';
  const template = botTemplate(bot.template_key);
  const computerReady = facts.computer.state === 'ready';
  // A computer-bound template without a computer opens with what it CAN do here.
  const templateCopy = template?.copy[facts.locale];
  const pitch = template?.needsComputer && !computerReady ? (templateCopy?.pitchNoComputer ?? '') : templateCopy?.pitch;
  const role = bot.role.trim();

  const lines: string[] = [];
  lines.push(
    zh
      ? `你好，我是 **${bot.name}**${role ? `，你的${role}` : ''}。${pitch ?? ''}`
      : `Hi, I'm **${bot.name}**${role ? `, your ${role.toLowerCase()}` : ''}. ${pitch ?? ''}`,
  );
  lines.push('');
  lines.push(zh ? '我能帮你：' : 'What I can do for you:');
  lines.push(
    zh
      ? '- 就在这里跟我说话就行——不用新建会话，这条对话一直延续，我会记得来龙去脉。'
      : '- Just talk to me here — no new sessions; this thread keeps going and I keep the context.',
  );
  if (computerReady) {
    lines.push(
      zh
        ? '- 用你名下的电脑上网搜索、阅读网页、下载和整理文件；你可以随时在右侧实时观看，或者接管过来。'
        : '- Use your own computer to search the web, read pages and handle files — watch it live on the right or take over any time.',
    );
    if (facts.vault) {
      lines.push(
        zh
          ? '- 需要登录的网站，用密码库替你填写——我看不到你的密码，每次使用都有记录。'
          : '- Sign in to sites with your password vault — I never see the passwords, and every use is logged.',
      );
    }
  }
  lines.push(
    zh
      ? '- 需要专长时把合适的 Bot 请进对话一起干活；新 Bot 要经过你确认才会创建。'
      : '- Bring the right Bot into the conversation when a job needs a specialist; new Bots are only created after you confirm.',
  );
  if (facts.backgroundTasks) {
    lines.push(
      zh
        ? '- 费时的核对和调研放到后台去做，完成后回到这里向你汇报，你可以继续聊别的。'
        : '- Run longer checks and research in the background and report back here while you keep chatting.',
    );
  }
  if (facts.memory.enabled) {
    lines.push(
      facts.memory.count > 0
        ? zh
          ? `- 我已经读过你的 ${facts.memory.count} 条偏好，会照着来（在「设置 → 记忆」里查看或修改）。`
          : `- I've read your ${facts.memory.count} saved preferences and will follow them (see Settings → Memory).`
        : zh
          ? '- 你告诉我的偏好我会记下来，在「设置 → 记忆」里随时查看和修改。'
          : '- I remember the preferences you tell me — review or edit them any time in Settings → Memory.',
    );
  }
  if (!computerReady && facts.computer.state !== 'checking') {
    lines.push('');
    lines.push(
      zh
        ? '（你的组织还没有为 Bot 开通电脑，所以我暂时不能替你浏览网页；可以请管理员在「管理 → Bot 电脑」里开通。）'
        : "(Your organisation hasn't enabled Bot computers yet, so I can't browse for you for now — an administrator can turn them on under Administration → Bot computers.)",
    );
  }
  lines.push('');
  lines.push(zh ? '想从哪儿开始？' : 'Where shall we start?');
  return lines.join('\n');
}

export async function greetingFacts(db: DatabaseProvider, userId: string): Promise<GreetingFacts> {
  const user = await db.users.getById(userId);
  const role = user?.role === 'super' ? 'super' : 'team';
  const memoryEnabled = user ? await userHasFeature(userId, role, 'memory', db) : false;
  const count = memoryEnabled ? (await db.userMemories.listForIndex(userId, { botId: null }, 100)).length : 0;
  return {
    locale: botsLocale(user?.locale),
    computer: getComputerRuntime(),
    vault: vaultAvailable(),
    backgroundTasks: runtimeDriverEnabled('subagent'),
    memory: { enabled: memoryEnabled, count },
  };
}

/** Append the greeting as the Bot's first DM message (idempotent per Bot). */
export async function writeGreeting(
  db: DatabaseProvider,
  dmSessionId: string,
  bot: Pick<BotRow, 'id' | 'name' | 'role' | 'template_key' | 'user_id'>,
  facts?: GreetingFacts,
): Promise<MessageRow> {
  const resolved = facts ?? (await greetingFacts(db, bot.user_id));
  return db.sessions.addMessageOnce(`bot-greeting:${bot.id}`, {
    session_id: dmSessionId,
    role: 'assistant',
    content: buildGreeting(bot, resolved),
    bot_id: bot.id,
    bot_event: JSON.stringify({ kind: 'greeting', bot_id: bot.id }),
  });
}
