/**
 * Bots — shared API contracts and the template catalog.
 *
 * Single source for the wire shapes the API returns under `/api/bots/*` and the
 * web app renders, plus the Bot templates both sides use (the API seeds a new
 * Bot from them; the web shows the gallery). Design:
 * docs/specs/20261005-personal-assistant-bots.md.
 */

import type { AvatarConfig } from './profile-manifest.js';
import { TEMPLATE_PLANT, plantAvatarConfig } from './plant-avatar.js';

// ─── Bots ────────────────────────────────────────────────

export interface BotView {
  id: string;
  name: string;
  role: string;
  /** One line on what the Bot is for (gallery, picker, `@` list). */
  description: string;
  instructions: string;
  avatar: AvatarConfig;
  model_id: string | null;
  /** Tool ids the Bot may use; null = the owner's whole allowed set. A list only narrows. */
  tools: string[] | null;
  /** Step cap per Chat turn / automation run; null = the base preset's default. */
  max_steps: number | null;
  template_key: string | null;
  status: 'active' | 'archived';
  /** The Bot's direct conversation, when it exists. */
  dm_session_id: string | null;
  /** Latest immutable manifest (`bot_versions.version`): every save appends one. */
  current_version: number;
  /** The owner's user id. */
  user_id: string;
  last_active_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One immutable manifest of a Bot (`GET /api/bots/:id/versions`). */
export interface BotVersionView {
  version: number;
  manifest_hash: string;
  change_log: string;
  name: string;
  role: string;
  description: string;
  instructions: string;
  tools: string[] | null;
  model_id: string | null;
  max_steps: number | null;
  avatar: AvatarConfig;
  created_by: string | null;
  created_at: string;
}

/** Name rules shared by the API validator and the web form. */
export const BOT_NAME_MAX = 24;
export const BOT_ROLE_MAX = 40;
export const BOT_DESCRIPTION_MAX = 500;
/** Matches what custom Agents allowed before the convergence (spec 20261007 §2.3). */
export const BOT_INSTRUCTIONS_MAX = 8000;
/** Per-member cap on active Bots (the built-in Sprouty is not counted). */
export const MAX_ACTIVE_BOTS = 20;
/** Words a Bot may not be called — they are speaker tags in the projected transcript. */
export const BOT_RESERVED_NAMES = ['用户', '系统', '事件', 'user', 'system', 'assistant', 'event', 'bot'] as const;

// ─── Templates ───────────────────────────────────────────

export type BotTemplateKey = 'sprouty' | 'chief' | 'researcher' | 'operator' | 'writer' | 'analyst';

export interface BotTemplateCopy {
  name: string;
  role: string;
  /** What the Bot is for, one line (gallery card). */
  pitch: string;
  /**
   * The pitch where the org has no Bot computer (needsComputer templates):
   * the greeting must never open with a capability the deployment lacks.
   */
  pitchNoComputer?: string;
  /**
   * Standing instructions, replayed every turn. Capability-neutral on purpose:
   * the shared rules (S1) describe each tool only when it exists and say
   * plainly when the computer or the vault is missing, so the instructions
   * never tell the model to use a tool it may not have.
   */
  instructions: string;
  /** Composer starters shown under the greeting. */
  starters: string[];
}

export interface BotTemplate {
  key: BotTemplateKey;
  /** The plant the template is named after (`TEMPLATE_PLANT`) + its resting mood, stored as `faceStyle` (`plantAvatarConfig`). */
  avatar: AvatarConfig;
  /** Needs the computer to be useful (marked in the gallery when the org has none). */
  needsComputer: boolean;
  copy: { en: BotTemplateCopy; zh: BotTemplateCopy };
}

/**
 * Sprouty — every member's built-in main Bot (key `sprouty`, the sprout plant). Created by
 * `POST /api/bots/bootstrap` for every member, pinned above every conversation, never archived
 * and never offered in the gallery. It is the one to talk to first: it helps directly, and
 * brings in the member's other Bots (adds them to the conversation, hands work over, proposes
 * new ones) when a job needs a specialist.
 */
export const SPROUTY_BOT_TEMPLATE: BotTemplate = {
  key: 'sprouty',
  avatar: plantAvatarConfig(TEMPLATE_PLANT.sprouty, 'calm'),
  needsComputer: false,
  copy: {
    en: {
      name: 'Sprouty',
      role: 'Main assistant',
      pitch: "Ask anything or hand me a task; when it needs a specialist, I'll bring in the right Bot.",
      instructions:
        "You are Sprouty, the member's main assistant and the one they talk to first. Help directly with questions, writing, research and everyday errands. Break bigger asks into steps and keep track of open items in the shared notes. Do small things yourself; when a job clearly belongs to a specialist, bring in the right Bot — add one of the member's Bots to this conversation or propose a new one — and hand it over with a precise brief. Report progress in one line.",
      starters: ['Plan my week from my open projects', 'What can my Bots do for me?', 'Create a researcher Bot for me'],
    },
    zh: {
      name: 'Sprouty',
      role: '主助手',
      pitch: '有问题直接问，有事交给我；需要专家时，我来请合适的 Bot。',
      instructions:
        '你是 Sprouty，这位成员的主助手，也是对方最先找的那一个。问答、写作、调研和日常杂事都直接帮忙。把大的请求拆成步骤，用共享笔记跟踪未完成的事项。小事自己做；明显属于专家的活，就请合适的 Bot 来——把成员已有的 Bot 拉进这个对话，或者提议新建一个——并给出准确的交接说明。进展用一句话汇报。',
      starters: ['根据我手上的项目帮我排一下这周', '我的 Bot 们能帮我做什么？', '帮我建一个研究员 Bot'],
    },
  },
};

/**
 * Retired templates: the chief of staff (藤藤 / Ivy) became Sprouty in 2026-10. Kept so Bots
 * created from it still find their pitch and starters; never offered for new Bots.
 */
const RETIRED_TEMPLATES: readonly BotTemplate[] = [
  {
    key: 'chief',
    avatar: plantAvatarConfig(TEMPLATE_PLANT.chief, 'calm'),
    needsComputer: false,
    copy: {
      en: {
        name: 'Ivy',
        role: 'Chief of staff',
        pitch: 'Your first point of contact — plans the work and brings in the right Bot.',
        instructions:
          "You are the member's chief of staff. Break bigger asks into steps and keep track of open items in the shared notes. Do small things yourself; when a job clearly belongs to a specialist, invite or create the right Bot and hand it over with a precise brief. Report progress in one line.",
        starters: [
          'Plan my week from my open projects',
          'What can my Bots do for me?',
          'Create a researcher Bot for me',
        ],
      },
      zh: {
        name: '藤藤',
        role: '总管',
        pitch: '理清需求、安排工作，需要时请合适的 Bot 来帮忙。',
        instructions:
          '你是这位成员的总管。把大的请求拆成步骤，用共享笔记跟踪未完成的事项。小事自己做；明显属于专家的活，邀请或新建合适的 Bot，并给出准确的交接说明。进展用一句话汇报。',
        starters: ['根据我手上的项目帮我排一下这周', '我的 Bot 们能帮我做什么？', '帮我建一个研究员 Bot'],
      },
    },
  },
];

/** The gallery: the specialists a member can add next to Sprouty. */
export const BOT_TEMPLATES: readonly BotTemplate[] = [
  {
    key: 'researcher',
    avatar: plantAvatarConfig(TEMPLATE_PLANT.researcher, 'calm'),
    needsComputer: true,
    copy: {
      en: {
        name: 'Dandy',
        role: 'Researcher',
        pitch: 'Searches the web on your computer, reads the sources, and cites them.',
        pitchNoComputer: 'Helps you research a question and organise the sources.',
        instructions:
          'You are a careful researcher. Go to primary sources whenever you can — official pages and recent material — and read them rather than relying on memory. Separate facts from interpretation, note dates, and always cite what you used (title + URL). Say plainly when you could not verify something.',
        starters: [
          'Compare the pricing of the top 3 vendors for …',
          'Summarise what changed in … this month',
          'Find the official docs for …',
        ],
      },
      zh: {
        name: '蒲蒲',
        role: '研究员',
        pitch: '在你的电脑上搜索网页、阅读原始资料，并注明出处。',
        pitchNoComputer: '帮你调研问题、整理资料来源。',
        instructions:
          '你是一位严谨的研究员。能查一手资料时就去查——优先官方页面和最新内容——亲自读过再下结论，而不是凭记忆。区分事实与解读，注明日期，并始终列出用到的资料（标题 + 链接）。核实不了的内容要直说。',
        starters: ['帮我对比一下……前三家的价格', '总结一下……这个月有什么变化', '找到……的官方文档'],
      },
    },
  },
  {
    key: 'operator',
    avatar: plantAvatarConfig(TEMPLATE_PLANT.operator, 'calm'),
    needsComputer: true,
    copy: {
      en: {
        name: 'Cactus',
        role: 'Operator',
        pitch: 'Operates websites for you — forms, downloads, routine admin.',
        pitchNoComputer: 'Walks you through routine online admin, step by step.',
        instructions:
          "You handle routine online admin on the member's behalf: forms, downloads, account chores. Work step by step and check the result after every action. For sign-ins, CAPTCHAs, one-time codes or anything only a person can do, use the safe way this deployment offers or ask the member to step in. Never submit anything irreversible (payments, sending messages, deleting, accepting terms) without the member's explicit go-ahead.",
        starters: [
          "Download last month's invoices from …",
          'Fill in this form with my details …',
          'Check the status of my order on …',
        ],
      },
      zh: {
        name: '仙仙',
        role: '操作员',
        pitch: '替你操作网站：填表、下载、日常事务。',
        pitchNoComputer: '一步步帮你处理日常的线上事务。',
        instructions:
          '你代表成员处理日常的线上事务：填表、下载文件、账号杂事。一步一步来，每次操作后都检查结果。遇到登录、验证码、一次性验证码或必须本人处理的环节，用当前部署提供的安全方式，或者请成员来处理。任何不可逆的操作（付款、发消息、删除、接受条款）都必须先得到成员明确同意。',
        starters: ['从……下载上个月的发票', '用我的资料填一下这个表单……', '帮我看看……上订单的状态'],
      },
    },
  },
  {
    key: 'writer',
    avatar: plantAvatarConfig(TEMPLATE_PLANT.writer, 'bright'),
    needsComputer: false,
    copy: {
      en: {
        name: 'Fern',
        role: 'Writer',
        pitch: 'Drafts and polishes documents, emails and posts in your voice.',
        instructions:
          "You are a writer and editor. Match the member's voice and the audience, lead with the point, and keep it tight. When polishing, keep the meaning and explain substantive changes in one line. When the length is unclear, write the short version and offer a longer one.",
        starters: [
          'Polish this announcement …',
          'Draft a reply to this email …',
          'Turn these notes into a one-page brief',
        ],
      },
      zh: {
        name: '卷卷',
        role: '写手',
        pitch: '用你的口吻起草和润色文档、邮件和帖子。',
        instructions:
          '你是写手兼编辑。贴合成员的口吻和读者，开门见山，简洁有力。润色时保持原意，实质性改动用一句话说明。长度不明确时，先给短版，再问要不要长版。',
        starters: ['帮我润色这段公告……', '帮我回复这封邮件……', '把这些要点整理成一页简报'],
      },
    },
  },
  {
    key: 'analyst',
    avatar: plantAvatarConfig(TEMPLATE_PLANT.analyst, 'calm'),
    needsComputer: true,
    copy: {
      en: {
        name: 'Clover',
        role: 'Analyst',
        pitch: 'Crunches data with Python on your computer and explains the numbers.',
        pitchNoComputer: 'Works through data you paste in and explains the numbers.',
        instructions:
          'You are a data analyst. Load, clean and analyse the data the member gives you — running code whenever you can rather than estimating by hand; show the key numbers in a small table or chart and state your assumptions. Share result files with the member when they are useful.',
        starters: [
          'Analyse this CSV and tell me what stands out',
          'Chart monthly totals from …',
          'Clean up this spreadsheet',
        ],
      },
      zh: {
        name: '叶叶',
        role: '分析师',
        pitch: '在你的电脑上用 Python 处理数据，并把数字讲清楚。',
        pitchNoComputer: '处理你贴进来的数据，把数字讲清楚。',
        instructions:
          '你是数据分析师。加载、清洗、分析成员给你的数据——能运行代码时就用代码算，而不是手工估算；用小表格或图表展示关键数字，并说明你的假设。有用的结果文件分享给成员。',
        starters: ['分析这个 CSV，告诉我有什么值得注意的', '按月汇总……并画个图', '把这个表格整理干净'],
      },
    },
  },
];

/** Any template a stored Bot may carry: Sprouty, the gallery, retired ones. */
export function botTemplate(key: string | null | undefined): BotTemplate | undefined {
  if (key === SPROUTY_BOT_TEMPLATE.key) return SPROUTY_BOT_TEMPLATE;
  return BOT_TEMPLATES.find((t) => t.key === key) ?? RETIRED_TEMPLATES.find((t) => t.key === key);
}

/** A template a member may create a Bot from — the gallery only (Sprouty comes from bootstrap). */
export function galleryTemplate(key: string | null | undefined): BotTemplate | undefined {
  return BOT_TEMPLATES.find((t) => t.key === key);
}

/** The member's built-in main Bot: pinned first, never archived. */
export function isSproutyBot(bot: { template_key?: string | null } | null | undefined): boolean {
  return bot?.template_key === SPROUTY_BOT_TEMPLATE.key;
}

// ─── Conversations ───────────────────────────────────────

/** owner = the DM's Bot, guest = a Bot invited into it; `lead` / `member` only on retired group chats. */
export type BotMemberRole = 'owner' | 'lead' | 'member' | 'guest';

export interface BotMemberView {
  bot_id: string;
  role: BotMemberRole;
  position: number;
}

/** "Needs you" > unread > working, the sidebar's attention order. */
export type BotConversationAttention = 'needs_you' | 'unread' | 'working' | 'idle';

export interface BotConversationSummary {
  session_id: string;
  /**
   * `group` = a retired group chat (2026-10-09): readable history, closed to new messages,
   * invites and card decisions (409 `group_closed`). Every conversation since is a Bot's DM;
   * other Bots join it as guests.
   */
  kind: 'direct' | 'group';
  title: string | null;
  owner_bot_id: string | null;
  lead_bot_id: string | null;
  members: BotMemberView[];
  last_message: { preview: string; bot_id: string | null; role: string; created_at: string } | null;
  attention: BotConversationAttention;
  pending_requests: number;
  /**
   * Bot replies (`assistant` rows) since the member last read the conversation, capped at
   * 99. `attention: 'unread'` with 0 here = only system events arrived (a hand-off, a
   * receipt). Absent from servers older than 2026-10 — clients fall back to a dot.
   */
  unread_count?: number;
  last_activity_at: string;
}

export interface BotSharedNoteView {
  id: number;
  title: string;
  body: string;
  author_bot_id: string | null;
  status: 'open' | 'done';
  pinned: boolean;
  updated_at: string;
}

/** Rendered rolling summary ("what it remembers lately"). */
export interface BotDigestView {
  text: string;
  upto_seq: number;
  updated_at: string | null;
}

export interface BotConversationDetail extends BotConversationSummary {
  /** A retired group's rules (history only); empty for a DM. */
  description: string;
  /** @deprecated Always true; hand-offs are always allowed. Kept for clients that still read it. */
  allow_bot_chat: boolean;
  digest: BotDigestView | null;
  notes: BotSharedNoteView[];
  requests: BotRequestView[];
  /** Estimated tokens of the raw (unsummarised) transcript vs the Bots compaction threshold. */
  context: { estimated_tokens: number; threshold: number };
}

// ─── "Needs you" requests ────────────────────────────────

export type BotRequestKind = 'takeover' | 'login' | 'approval' | 'bot_create' | 'task_start' | 'instructions_update';
export type BotRequestStatus = 'pending' | 'resolved' | 'denied' | 'expired' | 'canceled';

export interface BotTakeoverPayload {
  reason: string;
  kind: 'captcha' | 'other';
  /** Server-derived page URL (origin + path), when known. */
  url: string | null;
}

export interface BotLoginPayload {
  reason: string;
  kind: 'login' | 'otp';
  /** Server-derived origin of the page asking for credentials. */
  origin: string | null;
  url: string | null;
  /** Vault items whose origins match, metadata only. */
  vault_matches: Array<{ id: string; label: string; username_hint: string }>;
}

export interface BotApprovalPayload {
  /** What is being approved. */
  action: 'vault_fill' | 'tool_call';
  title: string;
  /**
   * What the Bot will do as a short verb phrase in the member's locale (`修改知识库` /
   * `edit the knowledge base`): the transcript line and the notification say it once
   * ("Sage asks to edit the knowledge base"). Absent on cards written before 2026-10-08.
   */
  summary?: string;
  /**
   * Server-derived detail lines (origin, item label, the call's arguments), labelled in
   * the member's locale. A value may end with `…(+N more characters)` and the last row may
   * be `{ label: '…', value: '+K more fields' }` — fixed English markers the clients parse.
   */
  details: Array<{ label: string; value: string }>;
  /** Offer "always allow on this site" (vault fills only). */
  allow_always: boolean;
}

export interface BotCreatePayload {
  name: string;
  role: string;
  instructions: string;
  avatar: AvatarConfig;
  template_key: string | null;
}

export interface BotTaskStartPayload {
  title: string;
  brief: string;
}

/**
 * A Bot proposing a change to its own standing instructions (`self` tool):
 * nothing changes until the member accepts the card — a Bot rewriting its own
 * rules after reading a page would otherwise be a persistent injection.
 * `current` is the text the proposal was made against (for the diff).
 */
export interface BotInstructionsUpdatePayload {
  instructions: string;
  reason: string;
  current: string;
}

/**
 * A take-over card the computer raised by itself: the member took over while a
 * Bot was mid-action (`interrupted`), or a Bot needed the computer while the
 * member held it (`waiting`). Handing back wakes that Bot. `title` is page
 * content — shown on the card only, never in transcript lines or notifications.
 */
export interface BotImplicitTakeoverPayload {
  implicit: true;
  reason: 'interrupted' | 'waiting';
  host?: string;
  title?: string;
}

export type BotRequestPayload =
  | BotTakeoverPayload
  | BotImplicitTakeoverPayload
  | BotLoginPayload
  | BotApprovalPayload
  | BotCreatePayload
  | BotTaskStartPayload
  | BotInstructionsUpdatePayload;

export interface BotRequestView {
  id: string;
  session_id: string;
  bot_id: string | null;
  kind: BotRequestKind;
  status: BotRequestStatus;
  payload: BotRequestPayload;
  result: Record<string, unknown> | null;
  expires_at: string | null;
  created_at: string;
}

/** Body of `POST /api/bots/requests/:id`. */
export interface BotRequestDecision {
  decision: 'approve' | 'always' | 'deny';
  /** bot_create: user-edited fields. */
  bot?: Partial<Pick<BotCreatePayload, 'name' | 'role' | 'instructions' | 'avatar'>>;
  /** instructions_update: the member's edited text (defaults to the proposal). */
  instructions?: string;
  /** login: secure sign-in values — sent once, filled server-side, never stored in the transcript. */
  login?: { username?: string; password?: string; otp?: string; save_to_vault?: boolean; submit?: boolean };
  /** takeover/login handback note. */
  note?: string;
}

// ─── Computer ────────────────────────────────────────────

export type ComputerRuntimeState = 'disabled' | 'checking' | 'unavailable' | 'ready';

export interface ComputerRuntimeView {
  state: ComputerRuntimeState;
  /** Machine-readable reason when not ready (docker_cli_missing, image_missing, runtime_missing…). */
  reason: string | null;
  /** Hardened (gVisor + verified network, or a hosted microVM) vs development mode. */
  hardened: boolean;
  /** Where computers run: this server's Docker host, or a hosted sandbox provider (E2B / PPIO). */
  driver?: 'docker' | 'e2b';
}

export type ComputerState = 'absent' | 'starting' | 'running' | 'stopping' | 'error';

export interface ComputerStatusView {
  runtime: ComputerRuntimeView;
  state: ComputerState;
  state_reason: string | null;
  controller: 'bot' | 'user';
  controller_since: string | null;
  last_active_at: string | null;
  /** Position in the start queue when the org's computers are all busy. */
  queue_position: number | null;
  disk_bytes: number | null;
  /** The member's own timezone for the computer (IANA), when set; the deployment default applies otherwise. */
  timezone: string | null;
  /** The browser language the computer starts with (BCP 47, e.g. zh-CN). */
  lang: string;
}

// ─── Computer files & processes (the member's view of ~/) ─

export interface ComputerFileEntry {
  name: string;
  type: 'file' | 'dir' | 'link' | 'other';
  /** Bytes (0 for directories). */
  size: number;
  /** ISO time of the last modification. */
  mtime: string;
}

export interface ComputerFileList {
  /** Absolute path of the listed directory (always under /home/agent). */
  path: string;
  entries: ComputerFileEntry[];
  /** More entries exist than were returned. */
  truncated: boolean;
}

/** `lost`: the process was running when the computer stopped, so its end was never recorded. */
export type ComputerProcessStatus = 'running' | 'exited' | 'lost';

/** A long job started with `gh-jobs` (by a Bot's run_background or from the terminal). */
export interface ComputerProcessView {
  id: string;
  name: string;
  command: string;
  cwd: string;
  status: ComputerProcessStatus;
  exit_code: number | null;
  started_at: string;
  ended_at: string | null;
  log_bytes: number;
}

export interface ComputerProcessLog {
  id: string;
  text: string;
  truncated: boolean;
}

/** One running/known computer, for the administration page. */
export interface ComputerAdminRow {
  user_id: string;
  nickname: string;
  state: ComputerState;
  state_reason: string | null;
  controller: 'bot' | 'user';
  last_active_at: string | null;
  last_started_at: string | null;
  disk_bytes: number | null;
  memory_bytes: number | null;
}

// ─── Vault ───────────────────────────────────────────────

export interface VaultItemView {
  id: string;
  label: string;
  origins: string[];
  username_hint: string;
  has_password: boolean;
  has_totp: boolean;
  policy: 'ask' | 'auto';
  always_origins: string[];
  last_used_at: string | null;
  created_at: string;
}

export interface VaultItemWrite {
  label?: string;
  origins?: string[];
  username?: string;
  /** Omit to keep the stored password; empty string clears it. */
  password?: string;
  /** Base32 secret or an otpauth:// URI. Omit to keep; empty string clears. */
  totp?: string;
  policy?: 'ask' | 'auto';
  /**
   * Revoke only (PATCH): the "always allow on this site" grants to keep. Must be
   * a subset of the current grants — new ones come only from an approval card.
   */
  always_origins?: string[];
}

export interface VaultAccessView {
  id: number;
  item_label: string;
  bot_id: string | null;
  origin: string;
  action: 'fill_login' | 'fill_totp' | 'secure_login';
  outcome: 'filled' | 'denied' | 'origin_mismatch' | 'failed';
  approval: 'auto' | 'once' | 'always' | 'user' | null;
  created_at: string;
}

// ─── Stream events (multi-speaker turns) ─────────────────

export type BotTurnReason = 'user' | 'mention' | 'ask' | 'followup' | 'continue' | 'interjection';

export interface BotTurnStartEvent {
  type: 'bot-turn-start';
  bot_id: string;
  reason: BotTurnReason;
  /** The Bot that asked (reason `ask`). */
  asked_by?: string;
}

/**
 * A soft stop was asked for (`POST /api/chat/runs/:sessionId/interrupt`): the
 * Bot speaking finishes its current step, then a queued member message is
 * answered, or the run ends. Sent once per request, replayed after a refresh.
 */
export interface RunInterruptingEvent {
  type: 'run-interrupting';
}

export interface BotTurnEndEvent {
  type: 'bot-turn-end';
  bot_id: string;
  /** `skipped`: a wrap-up turn that had nothing to add (nothing persisted). */
  status: 'completed' | 'error' | 'stopped' | 'skipped';
  message_id?: string;
  /** User-facing reason when status is `error`. */
  error?: string;
}

/** A "needs you" request was created inside the running turn (card renders immediately). */
export interface BotRequestEvent {
  type: 'bot-request';
  request: BotRequestView;
}

// ─── System events (messages.bot_event) ──────────────────

/**
 * Structured system events in a Bots conversation, stored as JSON in
 * `messages.bot_event` next to a human-readable `content` line.
 */
export type BotEvent =
  | { kind: 'ask'; from: string; to: string }
  | { kind: 'joined'; bot_id: string; by: 'user' | 'bot'; by_bot_id?: string }
  | { kind: 'left'; bot_id: string }
  | { kind: 'created'; bot_id: string }
  | { kind: 'takeover_done'; request_id: string | null; bot_id: string | null; note?: string }
  /** The member's viewers were gone for minutes while they held the computer: control went back, nobody was woken. */
  | { kind: 'takeover_released'; request_id: string | null; bot_id: string | null }
  | { kind: 'login_done'; request_id: string; origin: string | null; saved_to_vault: boolean }
  | { kind: 'task_started'; run_id: string; bot_id: string; title: string }
  | {
      kind: 'task_report';
      run_id: string;
      bot_id: string;
      title: string;
      status: 'succeeded' | 'failed' | 'canceled';
    }
  | { kind: 'limit'; reason: 'turns' | 'asks' | 'depth' | 'tokens' | 'steps' | 'wall_clock' }
  | { kind: 'turn_error'; bot_id: string; error: string }
  | { kind: 'digest'; upto_seq: number }
  | { kind: 'request'; request_id: string; request_kind: BotRequestKind; bot_id: string | null }
  /** The member accepted a Bot's proposal to change its own instructions (a new version). */
  | { kind: 'instructions_updated'; bot_id: string; version: number }
  | { kind: 'greeting'; bot_id: string }
  /**
   * Nobody could answer: the addressed Bot was archived or removed. Written instead of
   * ending silently. `no_active_members` only appears on rows from retired group chats.
   */
  | { kind: 'unavailable'; bot_id: string | null; reason: 'archived' | 'no_active_members' }
  /** The member pressed Stop while a wake-up (hand-back, joined Bot…) was queued: it was not resumed. */
  | { kind: 'stopped'; bot_id: string };

// ─── Messages ────────────────────────────────────────────

/** A persisted message as GET /api/bots/conversations/:id returns it (JSON columns parsed). */
export interface BotMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  bot_id: string | null;
  bot_event: BotEvent | null;
  pipeline: import('./session.js').PipelineStep[];
  references: import('./session.js').Reference[];
  reasoning: string | null;
  model: string | null;
  images: Array<{ id: string; url: string }>;
  created_at: string;
  seq: number;
}

// ─── Background tasks ────────────────────────────────────

export interface BotTaskView {
  run_id: string;
  bot_id: string;
  title: string;
  status: 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'canceled' | 'interrupted';
  /** The task's own (hidden) session. */
  child_session_id: string | null;
  summary: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

// ─── Error codes (the web's copy maps) ───────────────────
//
// The machine-readable `code` each Bots route family answers with. The web
// turns every one into a sentence in the member's language
// (`Partial<Record<Code, TranslationKey>>` maps that `satisfies` the full
// record), so a code added on the server without copy is a compile error
// here, not a raw English message on screen.

/**
 * Every `code` an `/api/bots/computer/*` route answers with:
 * ComputerUnavailableError codes (apps/api/src/bots/computer/errors.ts —
 * `over_quota` covers the member's own disk and the host's Docker disk),
 * `lease_required` (typing without holding the take-over lease) and
 * `invalid` (a malformed body).
 */
export type ComputerErrorCode =
  | 'disabled'
  | 'unavailable'
  | 'busy'
  | 'start_failed'
  | 'user_in_control'
  | 'stopped'
  | 'over_quota'
  | 'lease_required'
  | 'invalid'
  /** Files / processes: no such file, folder or job. */
  | 'not_found'
  /** Files: an upload over 100 MiB (or a download over 1 GiB). */
  | 'too_large';

/** Every `code` an `/api/bots/vault*` route answers with (apps/api/src/bots/vault/crypto.ts). */
export type VaultErrorCode =
  | 'vault_unavailable'
  | 'origin_invalid'
  | 'origin_forbidden'
  | 'label_invalid'
  | 'totp_invalid'
  | 'invalid'
  | 'not_found';

/**
 * Why a Bots conversation takes no new member message (`POST /api/chat`, 409) — it stays
 * readable either way: the DM's Bot was archived (`bot_archived`), or it is a retired group
 * chat (`group_closed`, which the member routes — invite / remove a Bot — answer too).
 */
export type BotConversationReadOnlyCode = 'bot_archived' | 'group_closed';

/**
 * `POST /api/bots/conversations` takes exactly one Bot id (that Bot's DM); any other count is
 * `400 groups_retired` — group chats are retired, a Bot brings others into its DM as guests.
 */
export type BotConversationErrorCode = 'groups_retired';

/**
 * `POST /api/bots/requests/:id` conflicts (409). `already_decided` /
 * `deciding` mean someone else settled it (or is settling it right now);
 * `group_closed` means the card belongs to a retired group chat (a pending one
 * is withdrawn as `canceled`); every other code is a decision the server could
 * not carry out while the request stays pending.
 */
export type BotRequestErrorCode =
  | 'already_decided'
  | 'deciding'
  | 'group_closed'
  | 'page_gone'
  | 'origin_mismatch'
  | 'no_fields'
  | 'failed'
  | 'invalid'
  | 'limit'
  | 'computer_restarted'
  | 'bot_gone';
