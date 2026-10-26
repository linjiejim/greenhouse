import { feedbackSummary } from './summary.js';
import manifest from '../manifest.js';
import { defineExtension, extensionPath, getDb, requireInternal, requireSuper } from '@greenhouse/api/extension-kit';
import { createServices } from './services.js';
import requests from './routes/feature-requests.js';
import frictions from './routes/frictions.js';
import { mobileFeedbackRoutes } from './routes/mobile.js';
import { featureRequestTool } from './tools/feature-request.js';
import { feedbackQueryTool } from './tools/feedback-query.js';
import { logFrictionTool } from './tools/log-friction.js';
import { mineToolErrors, mineEmptySearches } from './frictions/friction-center.js';
export default defineExtension({
  ...manifest,
  migrations: { dir: extensionPath(import.meta.url, '../migrations') },
  services: createServices,
  seeds: [{ dir: extensionPath(import.meta.url, '../seeds'), tables: ['feedback'] }],
  hubContext: [
    {
      group: 'feedback',
      description: 'Issues & requests: report frictions and feature requests to the team',
      toolIds: ['log_friction', 'feature_request'],
      overviewHint:
        '- Ran into something confusing or broken? Report it with log_friction; ideas go to feature_request.',
    },
  ],
  mcpGroups: ['feedback'],
  automationTools: [{ id: 'log_friction', labelKey: 'ext.feedback.automationTool', tier: 'assist', order: 40 }],
  resetTables: ['feedback'],
  tools: [featureRequestTool, feedbackQueryTool, logFrictionTool],
  routes: [
    { path: '/api/admin/feature-requests', app: requests, guards: [requireSuper()] },
    { path: '/api/admin/frictions', app: frictions, guards: [requireSuper()] },
    { path: '/api/me/feedback', app: mobileFeedbackRoutes, guards: [requireInternal()] },
  ],
  activity: [
    {
      toolModules: { feature_request: 'feedback', log_friction: 'feedback' },
      toolWrites: {
        feature_request: { entity: 'featureRequest', title: { result: 'request', field: 'title' } },
        log_friction: { verb: 'create', entity: 'friction' },
      },
    },
  ],
  summarySources: [{ id: 'member-feedback', load: feedbackSummary }],
  jobs: [
    {
      id: 'friction-mining',
      cron: '0 4 * * *',
      timezone: 'Asia/Shanghai',
      run: async () => {
        const db = getDb();
        await mineToolErrors(db);
        await mineEmptySearches(db);
      },
    },
  ],
});
