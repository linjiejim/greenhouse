/**
 * Agent 页面上下文类型 — 前端使用
 *
 * 定义 context-aware Assistant 浮层需要感知的页面类型及其参数。
 * 前端把页面事实转成逐轮 AmbientContextEnvelope；后端只验证通用
 * envelope 并做软提示注入，不需要理解这些页面类型。
 */

// ─── Page Context Types ──────────────────────────────────

export type PageContext =
  | ChatContext
  | EvalContext
  | FeatureRequestListContext
  | ProjectListContext
  | ProjectDetailContext
  | TablesContext
  | ExecutionCenterContext
  | ExtensionPageContext;

/** A page owned by a web extension (`#/<route>/<subPath>`); the extension supplies the provider. */
export interface ExtensionPageContext {
  type: 'extension';
  extension: string;
  route: string;
  subPath: string;
}

export interface ChatContext {
  type: 'chat';
  sessionId?: string;
  lastAssistantMessageId?: string;
}

export interface EvalContext {
  type: 'eval';
  runId?: string;
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
  /** Filled by page enrichment after the project loads. */
  projectTitle?: string;
}

export interface TablesContext {
  type: 'tables';
  baseId?: number;
  baseName?: string;
  /** The team's own usage note for this Base — what it holds and how to use it. */
  baseDescription?: string;
  tableId?: number;
  tableName?: string;
  /** Same for the open table; field names alone routinely mislead. */
  tableDescription?: string;
  dashboardId?: number;
  dashboardName?: string;
}

/** Durable cross-domain execution list or one Runtime run detail. */
export interface ExecutionCenterContext {
  type: 'execution-center';
  runKind?: 'mission' | 'workflow' | 'automation' | 'subagent' | 'eval';
  runId?: string;
  /** Filled by the detail page after the Runtime read model loads. */
  runTitle?: string;
  lifecycle?: string;
  attention?: string;
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
 * - UI 展示: label / emptyMessage / quickActions
 * - 后端提示: contextHint — 生成注入 system prompt 的上下文描述字符串
 */
export interface ContextProviderDescriptor<T extends PageContextType = PageContextType> {
  type: T;
  /** 上下文标签（显示在 Assistant 浮层顶部） */
  label: (ctx: ContextOfType<T>) => string;
  /** 空状态引导消息 */
  emptyMessage: (ctx: ContextOfType<T>) => string;
  /** 快捷操作列表 */
  quickActions: (ctx: ContextOfType<T>) => QuickAction[];
  /** 生成传给后端的上下文描述字符串 (注入 system prompt) */
  contextHint: (ctx: ContextOfType<T>) => string;
}

// ─── Per-turn ambient context ────────────────────────────

/**
 * A bounded snapshot of the application page visible when a chat turn starts.
 *
 * This is ambient reference data, not a user instruction and not a permission
 * grant. The API sanitizes it and wraps it in fixed soft-context guidance.
 */
export interface AmbientContextEnvelope {
  version: 1;
  scope_id: string;
  source: 'current-page';
  label: string;
  route: string;
  hint: string;
}

/** Generic launcher intent shared by every Assistant entry point. */
export interface AssistantLaunchRequest {
  id: number;
  newConversation?: boolean;
  sessionId?: string;
  profileId?: string;
  draft?: string;
  autoSend?: boolean;
}
