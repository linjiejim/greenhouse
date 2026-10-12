/** Super review of the immutable version hash; review alone never activates a version. */
import { effectiveUserId } from '@greenhouse/platform-kernel';
import type { AppCustomReviewItem } from '@greenhouse/types/apps';
import { parseStoredAppSpec } from '../app-spec.js';
import { customReviewView, versionSummary } from './apps.js';
import { fail, ok, payloadOf, positiveInt, stringValue, type Handler, type TablesHandlers } from './shared.js';

const listAppCustomReviews: Handler = async (request, context) => {
  if ((await context.db.users.getById(effectiveUserId(request.actor)))?.role !== 'super') {
    return fail('FORBIDDEN', 'Only administrators can review custom components');
  }
  const names = new Map((await context.db.users.list()).map((user) => [user.id, user.nickname]));
  const items: AppCustomReviewItem[] = [];
  for (const { app, version } of await context.db.tables.listAppCustomReviews()) {
    const spec = parseStoredAppSpec(version.spec);
    const review = customReviewView(version.custom_review, names);
    if (!spec || !review) continue;
    const previousRow = (await context.db.tables.listAppVersions(app.id)).find(
      (row) =>
        row.version < version.version &&
        row.custom_review?.status === 'approved' &&
        row.custom_review.hash === row.spec_hash,
    );
    const previousVersion = previousRow
      ? await context.db.tables.getAppVersion(app.id, previousRow.version)
      : undefined;
    const previousSpec = previousVersion ? parseStoredAppSpec(previousVersion.spec) : undefined;
    items.push({
      ...(previousRow && previousSpec
        ? {
            previous: {
              version: previousRow.version,
              cards: previousSpec.pages.flatMap((page) =>
                page.cards.flatMap((card) =>
                  card.kind === 'custom' ? [{ pageId: page.id, cardId: card.id, html: card.html }] : [],
                ),
              ),
            },
          }
        : {}),
      app: { id: app.id, name: app.name, baseId: app.base_id, ownerId: app.owner_id },
      version: version.version,
      specHash: version.spec_hash,
      review,
      publishedBy: { id: version.published_by, name: names.get(version.published_by) ?? version.published_by },
      publishedAt: version.published_at,
      cards: spec.pages.flatMap((page) =>
        page.cards.flatMap((card) =>
          card.kind === 'custom'
            ? [
                {
                  pageId: page.id,
                  cardId: card.id,
                  title: card.title,
                  html: card.html,
                  bindings: card.bindings,
                  actions: card.actions ?? [],
                  ...(card.create ? { create: card.create } : {}),
                },
              ]
            : [],
        ),
      ),
    });
  }
  return ok({ items });
};

const reviewAppCustomCode: Handler = async (request, context) => {
  const reviewerId = effectiveUserId(request.actor);
  if ((await context.db.users.getById(reviewerId))?.role !== 'super') {
    return fail('FORBIDDEN', 'Only administrators can review custom components');
  }
  const payload = payloadOf(request);
  const appId = positiveInt(payload, 'appId');
  const version = positiveInt(payload, 'version');
  const hash = stringValue(payload, 'hash');
  const note = stringValue(payload, 'note');
  const decision = payload.decision;
  if (
    !appId ||
    !version ||
    !hash ||
    !/^[a-f0-9]{64}$/.test(hash) ||
    (decision !== 'approve' && decision !== 'reject') ||
    (note && note.length > 2000)
  ) {
    return fail('INVALID_INPUT', 'A version hash and approve or reject decision are required');
  }
  const app = await context.db.tables.getApp(appId);
  const base = app ? await context.db.tables.getBase(app.base_id) : undefined;
  if (!app || app.archived_at || !base || base.archived_at) return fail('NOT_FOUND', 'App not found');
  const reviewed = await context.db.tables.reviewAppCustomCode(appId, { version, hash, decision, reviewerId, note });
  if (!reviewed) return fail('CONFLICT', 'The version or hash does not match the review', { reason: 'custom_review' });
  const names = new Map((await context.db.users.list()).map((user) => [user.id, user.nickname]));
  return ok(versionSummary(reviewed, names));
};

export const appReviewHandlers = { listAppCustomReviews, reviewAppCustomCode } satisfies TablesHandlers;
