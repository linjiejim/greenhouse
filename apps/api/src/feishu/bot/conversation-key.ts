/**
 * 飞书对话 → Greenhouse 会话的键，以及工具面收窄集合。
 *
 * 刻意是**零 import 叶子模块**：工具描述与 denylist 在模块求值期被读取，而
 * `tools/registry.ts` 会导入全部工具模块——常量若藏在会连到 db/security 的模块
 * 后面，一旦成环就是 TDZ，单测全绿但 API 起不来（automation 与 email 都踩过）。
 */

/** 事件里与「这是哪一串对话」相关的三个字段。 */
export interface FeishuThreadRefs {
  message_id: string;
  root_id?: string | null;
  parent_id?: string | null;
  thread_id?: string | null;
}

/**
 * 会话键 = `thread_id ?? root_id ?? message_id`（spec D1）。
 *
 * 一条回退链覆盖三种形态：话题群命中 `thread_id`（每个话题天然隔离）、普通
 * 回复链命中 `root_id`、首次发言用自己的 `message_id`（成为将来这条链的根）。
 *
 * **不要改用 `parent_id`**：实测它指向「被直接回复的那一条」，回复链上不同位置
 * 的消息 parent 各不相同；而 `root_id` 在整条链里恒定——正因如此，用户回复链上
 * 任意一条旧消息都会续上同一个会话，不必去找最后一条。
 */
export function feishuConversationKey(refs: FeishuThreadRefs): string {
  return refs.thread_id || refs.root_id || refs.message_id;
}

/**
 * 飞书面拿不到的工具。
 *
 * 两类，理由不同：
 *  - **编排类**（mission/workflow/schema-plan/task-capture）：它们的确认门是 Web
 *    专属的富卡片。IM 里没有 Launch 按钮那道天然减速带，一句话就能起一个几十
 *    分钟、烧沙箱与模型额度的任务（spec D4，Jim 拍板禁用）。
 *  - **会话编排**（spawn/call_llm）：本就 session-scoped 且只在带 sessionId 的
 *    chat 面装配，这里显式列出是为了让「飞书面有什么」可以只读这一处。
 *
 * 注意这**不是** `UNATTENDED_TOOL_DENYLIST`——飞书面对面有真人在等回答，不是
 * 无人值守（spec D6）。两者刻意分开：那份禁的是「没人能按确认」，这份禁的是
 * 「这个交互形态承载不了」。
 */
export const FEISHU_DENIED_TOOL_IDS: readonly string[] = [
  'mission_dispatch',
  'workflow_plan',
  'tables_schema_plan',
  'task_capture',
  'spawn_session',
  'call_llm',
];

const DENIED = new Set(FEISHU_DENIED_TOOL_IDS);

export function filterFeishuToolIds(toolIds: readonly string[]): string[] {
  return toolIds.filter((id) => !DENIED.has(id));
}

/** 群里的回答带这一行——让「谁的权限、给谁看」在每次发生时可见（spec D3）。 */
export function groupVisibilityFooter(displayName: string): string {
  return `\n\n---\n*以 ${displayName} 的权限查询，内容对本群可见*`;
}
