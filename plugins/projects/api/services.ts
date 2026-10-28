import { getExtensionServices, type Db, type DatabaseProvider } from '@greenhouse/api/extension-kit';
import { createProjectService } from './db-service.js';
export function createServices(db: Db) {
  return { projects: createProjectService(db) };
}
export type Services = ReturnType<typeof createServices>;
export function services(db: DatabaseProvider) {
  return getExtensionServices<Services>(db, 'projects');
}
