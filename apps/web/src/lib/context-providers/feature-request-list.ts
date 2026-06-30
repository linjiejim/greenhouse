import type { ContextProviderDescriptor } from '@greenhouse/types/agent-context';
import { BarChart3, Search, TrendingUp } from '../icons';
import { registerContextProvider } from '../context-registry';

const provider: ContextProviderDescriptor<'feature-request-list'> = {
  type: 'feature-request-list',

  label: (ctx) => `Feature Requests${ctx.totalPending ? ` (${ctx.totalPending} pending)` : ''}`,

  emptyMessage: () => 'Ask me to analyze feature requests, identify trends, or prioritize items',

  placeholder: () => 'Analyze requests, find patterns, prioritize...',

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
    `Current Context: Feature Requests. The user is managing feature requests submitted by internal users.` +
    (ctx.totalPending ? ` Pending requests: ${ctx.totalPending}.` : '') +
    ' You can help analyze, prioritize, and categorize feature requests. Use the feature_request tool to list and update requests.',
};

registerContextProvider(provider);
export default provider;
