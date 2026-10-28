import { getExtensionServices, type Db, type DatabaseProvider } from '@greenhouse/api/extension-kit';
import { createSkillService } from './db-service.js';
export function createServices(db: Db) {
  return { skills: createSkillService(db) };
}
export type Services = ReturnType<typeof createServices>;
export function services(db: DatabaseProvider) {
  return getExtensionServices<Services>(db, 'skills');
}
