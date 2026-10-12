import type { TableAppVersionRow } from '@greenhouse/db';
import type { AppSpec } from '@greenhouse/types/apps';

export function hasCustomCards(spec: AppSpec): boolean {
  return spec.pages.some((page) => page.cards.some((card) => card.kind === 'custom'));
}

export function customVersionApproved(spec: AppSpec, version: TableAppVersionRow): boolean {
  return (
    !hasCustomCards(spec) ||
    (version.custom_review?.status === 'approved' && version.custom_review.hash === version.spec_hash)
  );
}
