import type { ContextProviderDescriptor } from '@greenhouse/types/agent-context';
import { ClipboardList, BarChart3, Search, TrendingUp } from '../icons';
import { registerContextProvider } from '../context-registry';

const provider: ContextProviderDescriptor<'eval'> = {
  type: 'eval',

  label: (ctx) => (ctx.runId ? `Eval run: ${ctx.runId}` : 'Evaluation'),

  emptyMessage: () => 'Ask me about evaluation results or to run checks',

  quickActions: (ctx) => [
    {
      icon: ClipboardList,
      label: 'List recent runs',
      msg: 'List the recent evaluation runs with their scores and status.',
    },
    ...(ctx.runId
      ? [
          {
            icon: BarChart3,
            label: 'Analyze this run',
            msg: `Analyze evaluation run ${ctx.runId} and summarize the results, highlighting any weak areas.`,
          },
        ]
      : []),
    { icon: Search, label: 'Search runs', msg: 'Search evaluation runs by name: ' },
    {
      icon: TrendingUp,
      label: 'Compare latest runs',
      msg: 'Compare the two most recent evaluation runs and highlight any score changes.',
    },
  ],

  contextHint: (ctx) =>
    `Current Context: Evaluation Page.` +
    (ctx.runId ? ` Current eval run: ${ctx.runId}.` : '') +
    ' The visible page contains evaluation results, run comparisons, or message-level evaluation records.',
};

registerContextProvider(provider);
export default provider;
