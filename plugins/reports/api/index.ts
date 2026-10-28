import manifest from '../manifest.js';
import { defineExtension, extensionPath, requireInternal } from '@greenhouse/api/extension-kit';
import { createServices } from './services.js';
import { reportTemplateTarget, REPORT_TEMPLATE_ADMIN_ACTIONS, REPORT_TEMPLATE_PERSON_ACTIONS } from './audit.js';
import routes from './routes/report-templates.js';
import { reportTemplatesTool } from './tools/report-templates.js';
import { reportRenderTool } from './tools/report-render.js';
import { seedDefaultReportTemplates } from './defaults.js';
export default defineExtension({
  ...manifest,
  migrations: { dir: extensionPath(import.meta.url, '../migrations') },
  services: createServices,
  hubContext: [
    {
      group: 'reports',
      description:
        "Report templates: the team's required report / deck formats (report_templates), rendered to PDF / DOCX / PPTX into Files (report_render)",
      toolIds: ['report_templates'],
      overviewHint:
        '- Writing a report or deck? Call report_templates list first and follow the team template (report_templates validate checks it; report_render saves it into Files).',
      bundleHint: 'For a report or deck, call report_templates list first and follow the team template.',
    },
  ],
  automationTools: [{ id: 'report_render', labelKey: 'ext.reports.automationTool', tier: 'write', order: 80 }],
  resetTables: ['report_templates'],
  mcpGroups: ['reports'],
  tools: [reportTemplatesTool, reportRenderTool],
  routes: [{ path: '/api/report-templates', app: routes, guards: [requireInternal()] }],
  activity: [
    {
      appModules: { reports: 'skills' },
      toolModules: { report_render: 'files' },
      fileTools: ['report_render'],
      toolWrites: { report_render: { verb: 'create', entity: 'file' } },
      adminActions: { skills: [...REPORT_TEMPLATE_ADMIN_ACTIONS] },
      personActions: [{ appId: 'reports', module: 'skills', actionIds: REPORT_TEMPLATE_PERSON_ACTIONS }],
      targets: { reportTemplate: reportTemplateTarget },
    },
  ],
  onBoot: async ({ db }) => {
    await seedDefaultReportTemplates(db);
  },
});
