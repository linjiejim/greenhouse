/**
 * Where the server's spec problems belong in the builder. The validator
 * (`apps/api/src/platform/tables/app-spec.ts`) addresses each `AppSpecError`
 * by path (`pages[1].cards[0].actions[0].do`) and by the ids it sits in
 * (`pageId`, `cardId`, `actionId`, `filterId`, `roleKey`); the builder groups
 * them by those ids — indexes shift as the builder edits, ids do not — and
 * shows each next to the setting it is about (`relativePath`).
 */

import type { AppSpecError } from '@greenhouse/types/apps';

/** The path inside the card, page or role the error sits in (`actions[0].do`, `filters[1]`, `tables[0].rows`). */
export function relativePath(error: AppSpecError): string {
  return error.path.replace(/^pages\[\d+\]\.cards\[\d+\]\.?/, '').replace(/^(pages|roles)\[\d+\]\.?/, '');
}

export function cardErrors(errors: readonly AppSpecError[], pageId: string, cardId: string): AppSpecError[] {
  return errors.filter((error) => error.pageId === pageId && error.cardId === cardId);
}

/** Problems of the page itself (its title, filters, id) — not of its cards. */
export function pageOwnErrors(errors: readonly AppSpecError[], pageId: string): AppSpecError[] {
  return errors.filter((error) => error.pageId === pageId && !error.cardId);
}

/** Everything on a page, cards included (the page list's badge). */
export function pageErrorCount(errors: readonly AppSpecError[], pageId: string): number {
  return errors.filter((error) => error.pageId === pageId).length;
}

export function roleErrors(errors: readonly AppSpecError[], roleKey: string): AppSpecError[] {
  return errors.filter((error) => error.roleKey === roleKey && !error.pageId);
}

/** Problems that belong to no page and no role (`home`, the spec size). */
export function appErrors(errors: readonly AppSpecError[]): AppSpecError[] {
  return errors.filter((error) => !error.pageId && !error.roleKey);
}

/** Errors at `prefix` or below it (`actions[0]` matches `actions[0].do.values[1]`). */
export function errorsUnder(errors: readonly AppSpecError[], prefix: string): AppSpecError[] {
  return errors.filter((error) => {
    const path = relativePath(error);
    return path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`);
  });
}

/** Errors of an action, wherever it sits on the card (its id is unique per card). */
export function actionErrors(errors: readonly AppSpecError[], actionId: string): AppSpecError[] {
  return errors.filter((error) => error.actionId === actionId);
}
