import type { ContextProviderDescriptor } from '@greenhouse/types/agent-context';
import { BarChart3, ClipboardList, Search, FileText } from '@greenhouse/web/extension-kit';
import { getStoredLocale, translate } from '@greenhouse/web/extension-kit';

const tr = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate(getStoredLocale(), key, params);

const provider: ContextProviderDescriptor<'project-detail'> = {
  type: 'project-detail',

  label: (ctx) => tr('ext.projects.contextActions.projectLabel', { name: ctx.projectTitle || `#${ctx.projectId}` }),

  emptyMessage: (ctx) =>
    tr('ext.projects.contextActions.projectEmpty', { name: ctx.projectTitle || `#${ctx.projectId}` }),

  quickActions: (ctx) => [
    {
      icon: BarChart3,
      label: tr('ext.projects.contextActions.projectProgress'),
      msg: tr('ext.projects.contextActions.projectProgressPrompt', { name: ctx.projectTitle || ctx.projectId }),
    },
    {
      icon: ClipboardList,
      label: tr('ext.projects.contextActions.addTask'),
      msg: tr('ext.projects.contextActions.addTaskPrompt', { name: ctx.projectTitle || ctx.projectId }),
    },
    {
      icon: Search,
      label: tr('ext.projects.contextActions.overdueTasks'),
      msg: tr('ext.projects.contextActions.overdueTasksPrompt', { name: ctx.projectTitle || ctx.projectId }),
    },
    {
      icon: FileText,
      label: tr('ext.projects.contextActions.weeklyReport'),
      msg: tr('ext.projects.contextActions.weeklyReportPrompt', { name: ctx.projectTitle || ctx.projectId }),
    },
  ],

  contextHint: (ctx) =>
    `Current Context: Project Detail. Project: "${ctx.projectTitle || '(title loading)'}" (ID: ${ctx.projectId}). ` +
    'The visible project page contains list, board, and Gantt views.',
};

export default provider;
