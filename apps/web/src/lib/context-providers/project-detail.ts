import type { ContextProviderDescriptor } from '@greenhouse/types/agent-context';
import { BarChart3, ClipboardList, Search, FileText } from '../icons';
import { registerContextProvider } from '../context-registry';
import { getStoredLocale, translate } from '../i18n';

const tr = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate(getStoredLocale(), key, params);

const provider: ContextProviderDescriptor<'project-detail'> = {
  type: 'project-detail',

  label: (ctx) => tr('contextActions.projectLabel', { name: ctx.projectTitle || `#${ctx.projectId}` }),

  emptyMessage: (ctx) => tr('contextActions.projectEmpty', { name: ctx.projectTitle || `#${ctx.projectId}` }),

  quickActions: (ctx) => [
    {
      icon: BarChart3,
      label: tr('contextActions.projectProgress'),
      msg: tr('contextActions.projectProgressPrompt', { name: ctx.projectTitle || ctx.projectId }),
    },
    {
      icon: ClipboardList,
      label: tr('contextActions.addTask'),
      msg: tr('contextActions.addTaskPrompt', { name: ctx.projectTitle || ctx.projectId }),
    },
    {
      icon: Search,
      label: tr('contextActions.overdueTasks'),
      msg: tr('contextActions.overdueTasksPrompt', { name: ctx.projectTitle || ctx.projectId }),
    },
    {
      icon: FileText,
      label: tr('contextActions.weeklyReport'),
      msg: tr('contextActions.weeklyReportPrompt', { name: ctx.projectTitle || ctx.projectId }),
    },
  ],

  contextHint: (ctx) =>
    `Current Context: Project Detail. Project: "${ctx.projectTitle || '(title loading)'}" (ID: ${ctx.projectId}). ` +
    'The visible project page contains list, board, and Gantt views.',
};

registerContextProvider(provider);
export default provider;
