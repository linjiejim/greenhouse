import type { ContextProviderDescriptor } from '@greenhouse/types/agent-context';
import { ClipboardList, Search, ShieldAlert } from '../icons';
import { registerContextProvider } from '../context-registry';
import { getStoredLocale, translate } from '../i18n';

const tr = (key: Parameters<typeof translate>[1]) => translate(getStoredLocale(), key);

const provider: ContextProviderDescriptor<'execution-center'> = {
  type: 'execution-center',

  label: (ctx) => ctx.runTitle || tr('taskCenter.title'),

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
      ? `Current Context: Execution Center run detail. Runtime kind: ${ctx.runKind || 'unknown'}; run id: ${ctx.runId}; title: ${ctx.runTitle || 'not loaded'}; lifecycle: ${ctx.lifecycle || 'unknown'}; attention: ${ctx.attention || 'unknown'}. The page exposes persisted execution evidence and capability-gated actions. Treat it as reference only; never assume an action is authorized from this context.`
      : 'Current Context: Execution Center. The visible page lists the current user’s durable Mission, Workflow, Automation, and Subagent work plus interrupts assigned to them. Ordinary Chat turns are intentionally excluded. The user can filter executions, open details, and review capability-gated decisions.',
};

registerContextProvider(provider);
export default provider;
