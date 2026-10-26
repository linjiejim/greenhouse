import type { DatabaseProvider, TeamContextConfig, TeamContextDocumentSource } from '@greenhouse/api/extension-kit';
import { readTeamContextConfig } from '@greenhouse/api/extension-kit';
import type { KnowledgeDoc } from './knowledge-base.js';
import type { TeamContextDocProblem, TeamContextDocRef } from '@greenhouse/types/hub-context';
import { services } from './services.js';
/** Why a document cannot serve as team context, or null when it can. */
export function teamContextDocProblem(doc: KnowledgeDoc | undefined): TeamContextDocProblem | null {
  if (!doc) return 'missing';
  if (doc.status !== 'published') return 'archived';
  if (doc.visibility !== 'team') return 'not_team';
  return null;
}

function refOf(docId: string, doc: KnowledgeDoc | undefined): TeamContextDocRef {
  return { doc_id: docId, title: doc?.title ?? null, problem: teamContextDocProblem(doc) };
}

export interface ResolvedTeamContextDocs {
  /** Convention documents that still serve, in the admin's order. */
  conventions: KnowledgeDoc[];
  glossary: KnowledgeDoc | null;
  refs: { conventions: TeamContextDocRef[]; glossary: TeamContextDocRef | null };
}

/** Load the picked documents and drop any that no longer serve (see module doc). */
export async function resolveTeamContextDocs(
  db: DatabaseProvider,
  config?: TeamContextConfig,
): Promise<ResolvedTeamContextDocs> {
  const { conventionIds, glossaryId } = config ?? (await readTeamContextConfig());
  const load = (docId: string) => services(db).knowledgeBase.get(docId, 'shared');
  const [conventionDocs, glossaryDoc] = await Promise.all([
    Promise.all(conventionIds.map(load)),
    glossaryId ? load(glossaryId) : Promise.resolve(undefined),
  ]);
  const conventionRefs = conventionIds.map((id, index) => refOf(id, conventionDocs[index]));
  const glossaryRef = glossaryId ? refOf(glossaryId, glossaryDoc) : null;
  return {
    conventions: conventionDocs.filter(
      (doc, index): doc is KnowledgeDoc => doc !== undefined && conventionRefs[index]!.problem === null,
    ),
    glossary: glossaryDoc && glossaryRef?.problem === null ? glossaryDoc : null,
    refs: { conventions: conventionRefs, glossary: glossaryRef },
  };
}

/**
 * Check a selection before saving: every id must be a published, team-visible
 * document. Returns the first problem as a readable error.
 */
export async function validateTeamContextSelection(
  db: DatabaseProvider,
  input: { conventions: string[]; glossary: string | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ids = [...input.conventions, ...(input.glossary ? [input.glossary] : [])];
  for (const id of ids) {
    const problem = teamContextDocProblem(await services(db).knowledgeBase.get(id, 'shared'));
    if (problem === 'missing') return { ok: false, error: `Knowledge document "${id}" does not exist` };
    if (problem === 'archived') return { ok: false, error: `Knowledge document "${id}" is not published` };
    if (problem === 'not_team') {
      return { ok: false, error: `Knowledge document "${id}" is not visible to the whole team — share it first` };
    }
  }
  return { ok: true };
}

export const documentSource: TeamContextDocumentSource = {
  toolIds: ['knowledge_query'],
  resolve: async (db, config) => {
    const result = await resolveTeamContextDocs(db, config);
    const source = (doc: KnowledgeDoc) => ({
      ...doc,
      source: `greenhouse://knowledge/doc/${encodeURIComponent(doc.doc_id)}`,
    });
    return {
      ...result,
      conventions: result.conventions.map(source),
      glossary: result.glossary ? source(result.glossary) : null,
    };
  },
  validate: validateTeamContextSelection,
  candidates: async (db) =>
    (await services(db).knowledgeBase.list({ scope: 'shared', status: 'published', visibility: 'team', limit: 500 }))
      .filter((doc) => !doc.is_template)
      .map((doc) => ({ doc_id: doc.doc_id, title: doc.title })),
};
