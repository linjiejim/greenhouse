/**
 * Bots — server-written copy (system events, cards, notifications, speaker tags).
 *
 * Every line the engine itself writes into a transcript or a notification goes
 * through here, in the conversation owner's UI locale (`users.locale`). Two
 * reasons it is one module rather than inline strings:
 * - the speaker tags (`[小研（Bot）]:`) are a protocol, not decoration: the
 *   projection writes them, the static rules (S1) describe them, and Bot names
 *   are validated against them — all three must agree byte for byte;
 * - system events are persisted verbatim, so a wording change here is a change
 *   to what every later turn of every Bot reads back.
 */

import type { BotEvent, BotRequestKind } from '@greenhouse/types/bots';

export type BotsLocale = 'en' | 'zh';

export function botsLocale(raw: string | null | undefined): BotsLocale {
  return raw === 'zh' ? 'zh' : 'en';
}

// ─── Speaker tags (projection protocol) ──────────────────

/** Strip the characters that would let a nickname break out of a tag. */
function tagSafe(name: string): string {
  return name.replace(/[[\]:：\r\n]/g, '').trim() || '?';
}

export interface SpeakerTags {
  user(nickname: string): string;
  bot(name: string): string;
  event: string;
  task(name: string): string;
  deleted: string;
}

export const SPEAKER_TAGS: Record<BotsLocale, SpeakerTags> = {
  zh: {
    user: (nickname) => `[${tagSafe(nickname)}（用户）]:`,
    bot: (name) => `[${tagSafe(name)}（Bot）]:`,
    event: '[事件]:',
    task: (name) => `[后台任务·${tagSafe(name)}]:`,
    deleted: '[已删除的 Bot]:',
  },
  en: {
    user: (nickname) => `[${tagSafe(nickname)} (user)]:`,
    bot: (name) => `[${tagSafe(name)} (Bot)]:`,
    event: '[Event]:',
    task: (name) => `[Background task · ${tagSafe(name)}]:`,
    deleted: '[Deleted Bot]:',
  },
};

// ─── System events ───────────────────────────────────────

const LIMIT_REASON: Record<BotsLocale, Record<Extract<BotEvent, { kind: 'limit' }>['reason'], string>> = {
  zh: {
    turns: 'Bot 发言轮数',
    asks: '交接次数',
    depth: '交接层数',
    tokens: '本轮 token 用量',
    steps: '本轮步数',
    wall_clock: '本轮时长',
  },
  en: {
    turns: 'number of Bot turns',
    asks: 'number of hand-offs',
    depth: 'hand-off depth',
    tokens: 'token budget',
    steps: 'step budget',
    wall_clock: 'time limit',
  },
};

export const copy = {
  ask: (l: BotsLocale, from: string, to: string, message: string) =>
    l === 'zh' ? `${from} → @${to}：${message}` : `${from} → @${to}: ${message}`,

  limit: (l: BotsLocale, reason: Extract<BotEvent, { kind: 'limit' }>['reason']) =>
    l === 'zh'
      ? `已达协作上限（${LIMIT_REASON.zh[reason]}），这一轮先到这里。需要继续就再说一声。`
      : `Collaboration limit reached (${LIMIT_REASON.en[reason]}), so this round stops here. Say so if you want them to keep going.`,

  turnError: (l: BotsLocale, bot: string, reason: string) =>
    l === 'zh' ? `${bot} 没能回复（${reason}）` : `${bot} couldn't reply (${reason})`,

  created: (l: BotsLocale, name: string) => (l === 'zh' ? `新建了 Bot「${name}」` : `Created the Bot “${name}”`),

  joined: (l: BotsLocale, name: string, byBot?: string) =>
    l === 'zh'
      ? byBot
        ? `${name} 应 ${byBot} 的邀请加入了对话`
        : `${name} 加入了对话`
      : byBot
        ? `${name} joined at ${byBot}'s invitation`
        : `${name} joined the conversation`,

  left: (l: BotsLocale, name: string) => (l === 'zh' ? `${name} 离开了对话` : `${name} left the conversation`),

  taskStarted: (l: BotsLocale, bot: string, title: string) =>
    l === 'zh' ? `${bot} 开始了后台任务「${title}」` : `${bot} started the background task “${title}”`,

  taskUnavailable: (l: BotsLocale, title: string) =>
    l === 'zh'
      ? `这个部署已关闭后台任务，「${title}」没有开始。`
      : `Background tasks are turned off on this deployment, so “${title}” was not started.`,

  taskFailedReport: (l: BotsLocale, title: string, reason: string) =>
    l === 'zh' ? `后台任务「${title}」没有完成：${reason}` : `The background task “${title}” did not finish: ${reason}`,

  taskCanceledReport: (l: BotsLocale, title: string) =>
    l === 'zh' ? `后台任务「${title}」已取消。` : `The background task “${title}” was canceled.`,

  taskInterrupted: (l: BotsLocale) =>
    l === 'zh'
      ? '服务器重启打断了任务；为避免重复操作没有自动重跑。需要的话让我再开始一次。'
      : 'A server restart interrupted it; it was not re-run automatically to avoid repeating work. Ask me to start it again if needed.',

  taskReportTruncated: (l: BotsLocale, link: string) =>
    l === 'zh' ? `\n\n…（汇报较长，[完整内容](${link})）` : `\n\n…(long report — [full text](${link}))`,

  digest: (l: BotsLocale) => (l === 'zh' ? '更早的内容已整理成摘要' : 'Earlier messages were summarised'),

  /** Persisted for a turn that ran tools but wrote no text, so its work stays visible. */
  handedOver: (l: BotsLocale, names: string[]) =>
    l === 'zh' ? `（已交给 ${names.join('、')}）` : `(Handed over to ${names.join(', ')}.)`,
  // A turn that ended on a card with nothing to say: point at the card (this
  // line is also the conversation's preview in the sidebar).
  waitingForMember: (l: BotsLocale) =>
    l === 'zh' ? '轮到你了：请看上面的卡片。' : 'Over to you — see the card above.',
  workedWithoutText: (l: BotsLocale) => (l === 'zh' ? '（已完成上面的步骤）' : '(Done — see the steps above.)'),

  limitInterruption: (l: BotsLocale) =>
    l === 'zh' ? '已达到本轮协作上限，回复在这里中断。' : 'The collaboration limit for this round was reached here.',

  requestEvent: (l: BotsLocale, bot: string, kind: BotRequestKind, subject: string) => {
    const zh: Record<BotRequestKind, string> = {
      approval: `${bot} 请你批准：${subject}`,
      login: `${bot} 需要你登录${subject ? ` ${subject}` : ''}`,
      takeover: `${bot} 请你接管电脑：${subject}`,
      bot_create: `${bot} 提议新建 Bot「${subject}」`,
      task_start: `${bot} 提议后台任务「${subject}」`,
    };
    const en: Record<BotRequestKind, string> = {
      approval: `${bot} asks you to approve: ${subject}`,
      login: `${bot} needs you to sign in${subject ? ` to ${subject}` : ''}`,
      takeover: `${bot} asks you to take over the computer: ${subject}`,
      bot_create: `${bot} proposes a new Bot “${subject}”`,
      task_start: `${bot} proposes the background task “${subject}”`,
    };
    return (l === 'zh' ? zh : en)[kind];
  },

  /**
   * An implicit take-over (no card the Bot asked for): the member took the
   * screen while the Bot was acting, or the Bot found it in their hands. The
   * hand-back wakes the Bot, so the line says it will carry on.
   */
  implicitTakeover: (l: BotsLocale, bot: string, reason: 'interrupted' | 'waiting', host: string) => {
    const where = host ? (l === 'zh' ? `（${host}）` : ` (${host})`) : '';
    if (l === 'zh') {
      return reason === 'interrupted'
        ? `你接管了电脑，${bot} 的操作已暂停${where}——用完交还，它会接着做`
        : `${bot} 在等你交还电脑${where}——用完交还，它会接着做`;
    }
    return reason === 'interrupted'
      ? `You took over the computer and paused ${bot}${where} — hand it back when you're done and it will carry on`
      : `${bot} is waiting for the computer${where} — hand it back when you're done and it will carry on`;
  },

  declined: (l: BotsLocale, kind: BotRequestKind, subject: string) => {
    if (kind === 'bot_create') return l === 'zh' ? `你没有新建「${subject}」` : `You declined to create “${subject}”`;
    if (kind === 'task_start')
      return l === 'zh' ? `你没有开始后台任务「${subject}」` : `You declined the background task “${subject}”`;
    return l === 'zh' ? `你拒绝了：${subject}` : `You declined: ${subject}`;
  },

  approvalTitle: (l: BotsLocale, bot: string, toolName: string) =>
    l === 'zh' ? `允许 ${bot} 使用「${toolName}」？` : `Allow ${bot} to use ${toolName}?`,

  notificationBody: (l: BotsLocale) => (l === 'zh' ? '打开 Bots 查看并处理。' : 'Open Bots to review it.'),

  /** The addressed Bot is archived (a DM's owner, or a mentioned member): the message gets this line, not silence. */
  botArchived: (l: BotsLocale, name: string) =>
    l === 'zh'
      ? `${name} 已归档，无法回复；这段对话保留为只读记录。`
      : `${name} was archived and can't reply — this conversation stays readable.`,
  noActiveMembers: (l: BotsLocale) =>
    l === 'zh'
      ? '这里没有能回复的 Bot——先邀请一个 Bot 加入。'
      : 'No Bot here can reply — invite one to the conversation first.',

  /** Stop drained a queued wake-up without running it. */
  stoppedWakeup: (l: BotsLocale, name: string) =>
    l === 'zh'
      ? `已停止：${name} 不会自动继续，需要时说一声“继续”。`
      : `Stopped: ${name} won't pick this up on its own — say "continue" when you want it to.`,

  continueAfterCreate: (l: BotsLocale, name: string) =>
    l === 'zh'
      ? `成员确认新建了「${name}」，它已加入本对话。需要时用 team.ask 把工作交给它。`
      : `The member confirmed the new Bot “${name}”; it has joined this conversation. Hand it work with team.ask when it helps.`,
};
