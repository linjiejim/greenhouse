import type { ContextProviderDescriptor } from '@greenhouse/types/agent-context';
import { ClipboardList, TrendingUp, Search } from '../icons';
import { registerContextProvider } from '../context-registry';
import { getStoredLocale, translate } from '../i18n';

const tr = (key: Parameters<typeof translate>[1]) => translate(getStoredLocale(), key);

const provider: ContextProviderDescriptor<'project-list'> = {
  type: 'project-list',

  label: () => tr('contextActions.projectsOverview'),

  emptyMessage: () => tr('contextActions.projectsEmpty'),

  quickActions: () => [
    { icon: ClipboardList, label: tr('contextActions.allProjects'), msg: tr('contextActions.allProjectsPrompt') },
    { icon: TrendingUp, label: tr('contextActions.createProject'), msg: tr('contextActions.createProjectPrompt') },
    { icon: Search, label: tr('contextActions.overdueCheck'), msg: tr('contextActions.overdueCheckPrompt') },
  ],

  contextHint: () =>
    'Current Context: Project List. The visible page lists projects and exposes project creation and progress summaries.',
};

registerContextProvider(provider);
export default provider;
