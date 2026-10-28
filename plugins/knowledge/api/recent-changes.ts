import {
  scanRecentChanges,
  recentChangeDraft,
  humanActor,
  type DatabaseProvider,
  type PlatformRuntime,
  type RecentViewer,
  type RecentChangeWindow,
} from '@greenhouse/api/extension-kit';
import { type RecentChangeDraft } from '@greenhouse/api/extension-kit';
import { entityUrl } from '@greenhouse/types/entity-links';
import { canRead as canReadKb, resolveKbAccess } from './knowledge/access.js';
import { services } from './services.js';
export async function knowledgeChanges(
  db: DatabaseProvider,
  runtime: PlatformRuntime,
  viewer: RecentViewer,
  window: RecentChangeWindow,
  need: number,
) {
  if (!(await runtime.authorize(humanActor(viewer), 'knowledge.library.read')).allowed)
    return { items: [], exhausted: true, frontier: null };
  return scanRecentChanges(
    window,
    need,
    (cursor, limit) =>
      services(db).knowledgeBase.recentKnowledgeEdits({ userId: viewer.id, since: window.since, cursor, limit }),
    async (rows) => {
      const items: RecentChangeDraft[] = [];
      for (const row of rows) {
        const readable =
          row.visibility === 'team' ||
          row.owner_user_id === viewer.id ||
          canReadKb(
            await resolveKbAccess(
              db,
              { id: row.doc_pk, visibility: row.visibility, owner_user_id: row.owner_user_id },
              viewer.id,
            ),
          );
        if (!readable) continue;
        items.push(
          recentChangeDraft({
            id: row.key,
            source: 'person',
            at: row.at,
            actorId: row.changed_by,
            module: 'knowledge',
            verb: row.version <= 1 ? 'create' : 'update',
            entity: 'document',
            action: row.version <= 1 ? 'createDocument' : 'updateDocument',
            target: {
              id: String(row.doc_pk),
              label: row.title,
              url: entityUrl({ kind: 'kb_doc', id: row.doc_pk, slug: row.slug }),
            },
          }),
        );
      }
      return items;
    },
  );
}
