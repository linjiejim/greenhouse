import type { AppTemplateSummary } from '../shared/apps';

/** The API rechecks review; this keeps unavailable versions out of the install flow. */
export function templateInstallable(template: Pick<AppTemplateSummary, 'reviewStatus'>): boolean {
  return !template.reviewStatus || template.reviewStatus === 'approved' || template.reviewStatus === 'not_required';
}
