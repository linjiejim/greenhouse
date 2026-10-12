import type { AppCustomReviewInput, AppCustomReviewItem, AppVersionSummary } from '@greenhouse/types/apps';
import { rpc } from './client';
import { responseError } from './tables/shared';

export async function listAppCustomReviews(): Promise<AppCustomReviewItem[]> {
  const response = await rpc.api.apps.reviews.$get();
  if (!response.ok) throw await responseError(response, 'Unable to load component reviews');
  return (await response.json()).items;
}
export async function reviewAppCustomCode(
  appId: number,
  version: number,
  input: AppCustomReviewInput,
): Promise<AppVersionSummary> {
  const args = {
    param: { appId: String(appId), version: String(version) },
    json: input,
  };
  const response = await rpc.api.apps[':appId'].versions[':version'].review.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to save the review');
  return response.json();
}
