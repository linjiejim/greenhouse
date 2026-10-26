import type { ContextProviderDescriptor } from '@greenhouse/types/agent-context';
import { ClipboardList, TrendingUp, Search } from '@greenhouse/web/extension-kit';
import { getStoredLocale, translate } from '@greenhouse/web/extension-kit';

const tr = (key: Parameters<typeof translate>[1]) => translate(getStoredLocale(), key);

const provider: ContextProviderDescriptor<'project-list'> = {
  type: 'project-list',

  label: () => tr('ext.projects.contextActions.projectsOverview'),

  emptyMessage: () => tr('ext.projects.contextActions.projectsEmpty'),

  quickActions: () => [
    {
      icon: ClipboardList,
      label: tr('ext.projects.contextActions.allProjects'),
      msg: tr('ext.projects.contextActions.allProjectsPrompt'),
    },
    {
      icon: TrendingUp,
      label: tr('ext.projects.contextActions.createProject'),
      msg: tr('ext.projects.contextActions.createProjectPrompt'),
    },
    {
      icon: Search,
      label: tr('ext.projects.contextActions.overdueCheck'),
      msg: tr('ext.projects.contextActions.overdueCheckPrompt'),
    },
  ],

  contextHint: () =>
    'Current Context: Project List. The visible page lists projects and exposes project creation and progress summaries.',
};

export default provider;
