import type { ContextProviderDescriptor } from '@greenhouse/types/agent-context';
import { BarChart3, Search, TrendingUp } from '@greenhouse/web/extension-kit';

const provider: ContextProviderDescriptor<'extension'> = {
  type: 'extension',

  label: () => 'Feature Requests',

  emptyMessage: () => 'Ask me to analyze feature requests, identify trends, or prioritize items',

  quickActions: () => [
    {
      icon: BarChart3,
      label: 'Analyze pending requests',
      msg: 'Analyze all pending feature requests. Identify common themes, suggest priority ranking, and recommend which ones to accept or reject.',
    },
    {
      icon: TrendingUp,
      label: 'Trend analysis',
      msg: 'What are the most common types of feature requests? Are there patterns in what users are asking for?',
    },
    {
      icon: Search,
      label: 'Summarize requests',
      msg: 'Give me a concise summary of all open feature requests grouped by theme.',
    },
  ],

  contextHint: () =>
    `Current Context: Feature Requests. The visible page lists feature requests submitted by internal users.` +
    ' The page includes prioritization and categorization fields.',
};

export default provider;
