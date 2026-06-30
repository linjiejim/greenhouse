import type { ContextProviderDescriptor } from '@greenhouse/types/agent-context';
import { ClipboardList, TrendingUp, Search } from '../icons';
import { registerContextProvider } from '../context-registry';

const provider: ContextProviderDescriptor<'project-list'> = {
  type: 'project-list',

  label: () => 'Projects overview',

  emptyMessage: () => 'Ask me about your projects — create new ones, check progress, or get summaries.',

  placeholder: () => 'Ask about projects...',

  quickActions: () => [
    { icon: ClipboardList, label: '所有项目概览', msg: '列出所有进行中的项目及其进度' },
    { icon: TrendingUp, label: '创建新项目', msg: '帮我创建一个新项目' },
    { icon: Search, label: '逾期检查', msg: '检查所有项目中是否有逾期的任务' },
  ],

  contextHint: () =>
    'Current Context: Project List. The user is on the project list page. They can view all projects, create new ones, and check progress. Use the project_manager tool to help. Available actions: list_projects, create_project, get_project, query_tasks, project_summary.',
};

registerContextProvider(provider);
export default provider;
