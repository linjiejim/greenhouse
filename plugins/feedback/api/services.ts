import { getExtensionServices, type DatabaseProvider, type Db } from '@greenhouse/api/extension-kit';
import { createFeatureRequestService } from './db/feature-requests.js';
import { createToolFrictionService } from './db/tool-frictions.js';
export function createServices(db: Db) {
  return { featureRequests: createFeatureRequestService(db), toolFrictions: createToolFrictionService(db) };
}
export type FeedbackServices = ReturnType<typeof createServices>;
export function feedbackServices(db: DatabaseProvider): FeedbackServices {
  return getExtensionServices<FeedbackServices>(db, 'feedback');
}
