import type { AppPageContext, ContextProviderDescriptor, QuickAction } from '@greenhouse/types/agent-context';
import { AMBIENT_CONTEXT_LIMITS } from '@greenhouse/types/agent-context';
import { LayoutGrid, Search } from '../icons';
import { registerContextProvider } from '../context-registry';
import { getStoredLocale, translate } from '../i18n';

const tr = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate(getStoredLocale(), key, params);

/** App, page and filter names are member-written: one line each, bounded. */
const MAX_NAME = 120;
const MAX_FILTERS = 6;

function clip(text: string, max = MAX_NAME): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

function appName(context: AppPageContext): string {
  return context.appName ? clip(context.appName) : tr('apps.agent.context.unnamedApp', { id: context.appId });
}

const provider: ContextProviderDescriptor<'app-page'> = {
  type: 'app-page',

  label: (context) => {
    const app = appName(context);
    if (context.mode === 'build') return tr('apps.agent.context.builderLabel', { app });
    return context.pageTitle
      ? tr('apps.agent.context.label', { app, page: clip(context.pageTitle) })
      : tr('apps.agent.context.appOnly', { app });
  },

  emptyMessage: (context) =>
    tr(context.mode === 'build' ? 'apps.agent.context.builderEmpty' : 'apps.agent.context.empty', {
      app: appName(context),
    }),

  quickActions: (context): QuickAction[] => {
    const app = appName(context);
    if (context.mode === 'build') {
      return [
        {
          icon: LayoutGrid,
          label: tr('apps.agent.context.planPage'),
          msg: tr('apps.agent.context.planPagePrompt', { app }),
        },
      ];
    }
    if (!context.pageTitle) return [];
    return [
      {
        icon: Search,
        label: tr('apps.agent.context.explainPage'),
        msg: tr('apps.agent.context.explainPagePrompt', { app, page: clip(context.pageTitle) }),
      },
    ];
  },

  // Facts only: which app, page, role and filters are on screen. Member-written names are clipped.
  contextHint: (context) => {
    const parts = [
      context.mode === 'build'
        ? `Current Context: the builder of a member-built app (app ${context.appId}), editing its draft`
        : `Current Context: a member-built app (app ${context.appId}) as its viewer uses it`,
    ];
    if (context.appName) parts.push(`App name: ${clip(context.appName)}`);
    if (context.version !== undefined) parts.push(`Published version: ${context.version}`);
    if (context.pageId || context.pageTitle) {
      parts.push(
        `Page: ${context.pageTitle ? clip(context.pageTitle) : '(title loading)'}${context.pageId ? ` (id ${clip(context.pageId, 40)})` : ''}`,
      );
    }
    if (context.roleName) parts.push(`Viewer's app role: ${clip(context.roleName)}`);
    const filters = (context.filters ?? []).slice(0, MAX_FILTERS);
    if (filters.length > 0) {
      parts.push(
        `Page filters set: ${filters.map((filter) => `${clip(filter.label, 60)} = ${clip(filter.value, 80)}`).join('; ')}`,
      );
    }
    parts.push(
      'An app grants access through its own roles: what the page shows is evaluated for this viewer, and Tables tools reach the underlying Base only if the viewer has Tables access to it',
    );
    return parts.join('. ').slice(0, AMBIENT_CONTEXT_LIMITS.hint);
  },
};

registerContextProvider(provider);
export default provider;
