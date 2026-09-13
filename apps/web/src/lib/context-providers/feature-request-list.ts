import type { ContextProviderDescriptor } from '@greenhouse/types/agent-context';
import { BarChart3, Search, TrendingUp } from '../icons';
import { registerContextProvider } from '../context-registry';

const provider: ContextProviderDescriptor<'feature-request-list'> = {
  type: 'feature-request-list',

  label: (ctx) => `Feature Requests${ctx.totalPending ? ` (${ctx.totalPending} pending)` : ''}`,

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

  contextHint: (ctx) =>
    `Current Context: Feature Requests. The visible page lists feature requests submitted by internal users.` +
    (ctx.totalPending ? ` Pending requests: ${ctx.totalPending}.` : '') +
    ' The page includes prioritization and categorization fields.',
};

registerContextProvider(provider);
export default provider;
