import { getExtensionServices, type DatabaseProvider, type Db } from '@greenhouse/api/extension-kit';
import { createKnowledgeBaseService } from './knowledge-base.js';
import { createKnowledgeShareService } from './knowledge-shares.js';
export function createServices(db: Db) {
  return { knowledgeBase: createKnowledgeBaseService(db), knowledgeShares: createKnowledgeShareService(db) };
}
export type Services = ReturnType<typeof createServices>;
export function services(db: DatabaseProvider) {
  return getExtensionServices<Services>(db, 'knowledge');
}
