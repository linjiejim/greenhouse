import { getExtensionServices, type DatabaseProvider, type Db } from '@greenhouse/api/extension-kit';
import { createReportTemplateService } from './db/report-templates.js';
export function createServices(db: Db) {
  return { reportTemplates: createReportTemplateService(db) };
}
export type ReportsServices = ReturnType<typeof createServices>;
export function reportsServices(db: DatabaseProvider): ReportsServices {
  return getExtensionServices<ReportsServices>(db, 'reports');
}
