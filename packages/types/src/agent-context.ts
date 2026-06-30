/**
 * Agent 页面上下文类型 — 前端使用
 *
 * 定义 Agent panel 需要感知的页面类型及其参数。
 * 上下文描述(context hint)由前端生成并作为字符串传给后端，
 * 后端不需要理解这些类型。
 */

// ─── Page Context Types ──────────────────────────────────

export type PageContext =
  | ChatContext
  | HistoryContext
  | FeatureRequestListContext
  | ProjectListContext
  | ProjectDetailContext;

export interface ChatContext {
  type: 'chat';
  sessionId?: string;
  lastAssistantMessageId?: string;
}

export interface HistoryContext {
  type: 'history';
}

export interface FeatureRequestListContext {
  type: 'feature-request-list';
  totalPending?: number;
}

export interface ProjectListContext {
  type: 'project-list';
}

export interface ProjectDetailContext {
  type: 'project-detail';
  projectId: number;
  projectTitle: string;
}

// ─── Utility Types ───────────────────────────────────────

/** 所有支持的页面类型 */
export type PageContextType = PageContext['type'];

/** 根据 type 提取对应的 context 类型 */
export type ContextOfType<T extends PageContextType> = Extract<PageContext, { type: T }>;

// ─── Quick Action ────────────────────────────────────────

export interface QuickAction {
  icon: unknown; // LucideIcon (避免后端依赖 React)
  label: string;
  msg: string;
}

// ─── Context Provider Descriptor ─────────────────────────

/**
 * 页面上下文提供者 — 纯前端使用。
 *
 * 每种页面类型注册一个 descriptor，提供:
 * - UI 展示: label / emptyMessage / placeholder / quickActions
 * - 后端提示: contextHint — 生成注入 system prompt 的上下文描述字符串
 */
export interface ContextProviderDescriptor<T extends PageContextType = PageContextType> {
  type: T;
  /** 上下文标签（显示在 Agent panel 顶部） */
  label: (ctx: ContextOfType<T>) => string;
  /** 空状态引导消息 */
  emptyMessage: (ctx: ContextOfType<T>) => string;
  /** 输入框 placeholder */
  placeholder: (ctx: ContextOfType<T>) => string;
  /** 快捷操作列表 */
  quickActions: (ctx: ContextOfType<T>) => QuickAction[];
  /** 生成传给后端的上下文描述字符串 (注入 system prompt) */
  contextHint: (ctx: ContextOfType<T>) => string;
}
