import {
  activityField as field,
  activityIdText as idText,
  activityText as text,
  type HydrateContext,
  type ActivityRunRow,
} from '@greenhouse/api/extension-kit';
import { entityUrl } from '@greenhouse/types/entity-links';
import { canRead as canReadKb, resolveKbAccess } from './knowledge/access.js';
import { services } from './services.js';
export async function knowledgeTarget(ctx: HydrateContext, recordId: string) {
  try {
    // The kernel records either the row id or the doc slug, depending on the caller.
    const doc =
      (await services(ctx.db).knowledgeBase.getById(recordId)) ??
      (await services(ctx.db).knowledgeBase.get(recordId, 'shared'));
    if (!doc || !canReadKb(await resolveKbAccess(ctx.db, doc, ctx.viewer.id))) return null;
    return { label: doc.title, url: entityUrl({ kind: 'kb_doc', id: doc.id, slug: doc.doc_id }) };
  } catch {
    return null;
  }
}

export async function toolTarget(
  ctx: HydrateContext,
  row: ActivityRunRow,
  _action: string | null,
  shape: { verb: string },
) {
  const input = field(row.input, 'input');
  const result = field(row.output, 'result');
  const creates = shape.verb === 'create';
  const id = creates ? idText(field(result, 'document', 'id')) : idText(field(input, 'doc_id'));
  const live = id ? await knowledgeTarget(ctx, id) : null;
  if (live) return { id, ...live };
  const kept = text(field(result, 'document', 'title'), creates ? field(input, 'title') : null);
  return kept && ctx.viewer.id === row.owner_user_id ? { id, label: kept, url: null } : null;
}
