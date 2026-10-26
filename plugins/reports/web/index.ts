import manifest from '../manifest.js';
import { defineWebExtension } from '@greenhouse/web/extension-kit';
import en from './messages/en.js';
import zh from './messages/zh.js';
import { FileText } from '@greenhouse/web/extension-kit';
import { ReportTemplatesPanel } from './pages/skillhub/report-templates.js';
export default defineWebExtension({
  ...manifest,
  messages: { en, zh },
  tabs: [
    {
      host: 'skillhub',
      key: 'reports',
      labelKey: 'ext.reports.reportTemplates.title',
      component: ReportTemplatesPanel,
    },
  ],
  toolIcons: { report_templates: FileText, report_render: FileText },
  mcpGroups: [
    {
      id: 'reports',
      labelKey: 'ext.reports.mcp.label',
      descriptionKey: 'ext.reports.mcp.description',
    },
  ],
});
