import type {
  AppTemplateDetailView,
  AppTemplatePublishInput,
  AppTemplateReviewInput,
  AppTemplateVersionView,
} from '@greenhouse/types/apps';
import { rpc } from './client';
import { responseError } from './tables/shared';
export async function getAppTemplate(key: string, version?: string): Promise<AppTemplateDetailView> {
  const args = { param: { key }, query: { ...(version ? { version } : {}) } };
  const response = await rpc.api.apps.templates[':key'].$get(args);
  if (!response.ok) throw await responseError(response, 'Unable to load template');
  return response.json();
}
export async function publishAppTemplate(input: AppTemplatePublishInput): Promise<AppTemplateDetailView> {
  const args = { json: input };
  const response = await rpc.api.apps.templates.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to publish template');
  return response.json();
}
export async function reviewAppTemplate(
  key: string,
  version: string,
  input: AppTemplateReviewInput,
): Promise<AppTemplateVersionView> {
  const args = { param: { key, version }, json: input };
  const response = await rpc.api.apps.templates[':key'].versions[':version'].review.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to review template');
  return response.json();
}
export async function archiveAppTemplate(key: string): Promise<AppTemplateDetailView> {
  const response = await rpc.api.apps.templates[':key'].archive.$post({ param: { key } });
  if (!response.ok) throw await responseError(response, 'Unable to archive template');
  return response.json();
}
