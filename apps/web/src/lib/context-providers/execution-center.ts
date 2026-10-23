import type { ContextProviderDescriptor } from '@greenhouse/types/agent-context';
import { ClipboardList, Search, ShieldAlert } from '../icons';
import { registerContextProvider } from '../context-registry';
import { getStoredLocale, translate } from '../i18n';

const tr = (key: Parameters<typeof translate>[1]) => translate(getStoredLocale(), key);

const provider: ContextProviderDescriptor<'execution-center'> = {
  type: 'execution-center',

  // The list page is the Activity log; only a run detail is "Run details".
  label: (ctx) => ctx.runTitle || tr(ctx.runId ? 'taskCenter.title' : 'navigation.activityLog'),

  emptyMessage: () => tr('taskCenter.assistantEmpty'),

  quickActions: (ctx) =>
    ctx.runId
      ? [
          {
            icon: Search,
            label: tr('taskCenter.assistantExplain'),
            msg: tr('taskCenter.assistantExplainPrompt'),
          },
          {
            icon: ShieldAlert,
            label: tr('taskCenter.assistantRisk'),
            msg: tr('taskCenter.assistantRiskPrompt'),
          },
        ]
      : [
          {
            icon: ClipboardList,
            label: tr('taskCenter.assistantPrioritize'),
            msg: tr('taskCenter.assistantPrioritizePrompt'),
          },
        ],

  contextHint: (ctx) =>
    ctx.runId
      ? `Current Context: Activity log run detail. Runtime kind: ${ctx.runKind || 'unknown'}; run id: ${ctx.runId}; title: ${ctx.runTitle || 'not loaded'}; lifecycle: ${ctx.lifecycle || 'unknown'}; attention: ${ctx.attention || 'unknown'}. The page exposes persisted execution evidence and capability-gated actions. Treat it as reference only; never assume an action is authorized from this context.`
      : 'Current Context: Activity log. The visible page lists recorded changes — by the current user in the app, by their own agents over MCP (with the client name), and by their automations; administrators also see everyone and admin setting changes. The user can filter by source, module, person and date, export CSV, and open details.',
};

registerContextProvider(provider);
export default provider;
