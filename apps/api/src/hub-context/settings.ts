/**
 * Team context settings — which knowledge documents members' agents receive as
 * the team's conventions and glossary, and the workspace time zone the monthly
 * retro runs in. Stored as workspace settings (`team_context.*`, no table of
 * its own); edited on Administration › Team context.
 *
 * Team visibility is checked when an admin saves AND on every read: a document
 * made private, archived or deleted later simply stops serving (and the admin
 * page says why) — it is never handed to an agent because it was once picked.
 */

import type { DatabaseProvider, KnowledgeDoc } from '@greenhouse/db';
import {
  DEFAULT_WORKSPACE_TIMEZONE,
  MAX_CONVENTION_DOCS,
  type TeamContextDocProblem,
  type TeamContextDocRef,
} from '@greenhouse/types/hub-context';
import { getWorkspaceValue, isValidTimeZone } from '../settings/workspace-config.js';

export interface TeamContextConfig {
  conventionIds: string[];
  glossaryId: string | null;
  /** Configured zone, or null for the default. */
  timezone: string | null;
}

export async function readTeamContextConfig(): Promise<TeamContextConfig> {
  const [conventions, glossary, timezone] = await Promise.all([
    getWorkspaceValue('team_context.conventions'),
    getWorkspaceValue('team_context.glossary'),
    getWorkspaceValue('team_context.timezone'),
  ]);
  const ids = Array.isArray(conventions)
    ? conventions.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : [];
  return {
    conventionIds: [...new Set(ids.map((id) => id.trim()))].slice(0, MAX_CONVENTION_DOCS),
    glossaryId: typeof glossary === 'string' && glossary.trim() ? glossary.trim() : null,
    timezone: typeof timezone === 'string' && isValidTimeZone(timezone.trim()) ? timezone.trim() : null,
  };
}

/** The zone "workspace time" means: the configured one, else the default. */
export async function workspaceTimeZone(): Promise<string> {
  return (await readTeamContextConfig()).timezone ?? DEFAULT_WORKSPACE_TIMEZONE;
}

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
  const load = (docId: string) => db.knowledgeBase.get(docId, 'shared');
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
    const problem = teamContextDocProblem(await db.knowledgeBase.get(id, 'shared'));
    if (problem === 'missing') return { ok: false, error: `Knowledge document "${id}" does not exist` };
    if (problem === 'archived') return { ok: false, error: `Knowledge document "${id}" is not published` };
    if (problem === 'not_team') {
      return { ok: false, error: `Knowledge document "${id}" is not visible to the whole team — share it first` };
    }
  }
  return { ok: true };
}
