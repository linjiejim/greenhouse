import type { ContextProviderDescriptor } from '@greenhouse/types/agent-context';
import { BarChart3, ClipboardList, Search, FileText } from '../icons';
import { registerContextProvider } from '../context-registry';

const provider: ContextProviderDescriptor<'project-detail'> = {
  type: 'project-detail',

  label: (ctx) => `Project: ${ctx.projectTitle}`,

  emptyMessage: (ctx) => `Ask me about "${ctx.projectTitle}" — add tasks, update progress, or get a summary.`,

  placeholder: (ctx) => `Ask about ${ctx.projectTitle}...`,

  quickActions: (ctx) => [
    { icon: BarChart3, label: '项目进度', msg: `查看项目「${ctx.projectTitle}」的进度汇总` },
    { icon: ClipboardList, label: '添加任务', msg: `在项目「${ctx.projectTitle}」中添加一个新任务` },
    { icon: Search, label: '逾期任务', msg: `检查项目「${ctx.projectTitle}」中有哪些逾期任务` },
    { icon: FileText, label: '周报', msg: `帮我生成项目「${ctx.projectTitle}」的进度周报` },
  ],

  contextHint: (ctx) =>
    `Current Context: Project Detail. Project: "${ctx.projectTitle}" (ID: ${ctx.projectId}). ` +
    "The user is viewing this project's detail page with list, board, and Gantt views. " +
    `Use the project_manager tool with project_id=${ctx.projectId}. Available actions: get_project, create_task, update_task, add_comment, query_tasks, project_summary.`,
};

registerContextProvider(provider);
export default provider;
