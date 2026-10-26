import contextProvider from './lib/context-providers/feature-request-list.js';
import manifest from '../manifest.js';
import { defineWebExtension } from '@greenhouse/web/extension-kit';
import en from './messages/en.js';
import zh from './messages/zh.js';
import { ClipboardList, Lightbulb, MessageSquareWarning } from '@greenhouse/web/extension-kit';
import { IssuesPanel } from './pages/administration/issues.js';
export default defineWebExtension({
  ...manifest,
  messages: { en, zh },
  contextProvider,
  toolIcons: { feature_request: Lightbulb, feedback_query: ClipboardList, log_friction: MessageSquareWarning },
  mcpGroups: [{ id: 'feedback', labelKey: 'ext.feedback.mcp.label', descriptionKey: 'ext.feedback.mcp.description' }],
  redirects: {
    settings: {
      issues: '#/administration/issues',
      'feature-requests': '#/administration/issues/requests',
      frictions: '#/administration/issues/frictions',
    },
    administration: {
      'feature-requests': '#/administration/issues/requests',
      frictions: '#/administration/issues/frictions',
    },
  },
  modules: [
    {
      key: 'issues',
      parent: 'administration',
      labelKey: 'ext.feedback.nav_issues',
      descriptionKey: 'ext.feedback.nav_issuesDesc',
      icon: ClipboardList,
      component: IssuesPanel,
      requireRole: ['super'],
    },
  ],
});
