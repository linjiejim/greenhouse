/** Core Markdown context with optional team-document sources contributed by plugins. */
import type { DatabaseProvider } from '@greenhouse/db';
import {
  DEFAULT_WORKSPACE_TIMEZONE,
  MAX_CONVENTION_DOCS,
  type TeamContextDocRef,
  type TeamContextCandidate,
} from '@greenhouse/types/hub-context';
import { getWorkspaceValue, isValidTimeZone } from '../settings/workspace-config.js';
let documentSources: TeamContextDocumentSource[] = [];
export function registerTeamContextDocumentSources(sources: TeamContextDocumentSource[]) {
  if (sources.length > 1) throw new Error('Only one team document source may be enabled');
  documentSources = sources;
}
export interface TeamContextConfig {
  conventionIds: string[];
  glossaryId: string | null;
  timezone: string | null;
  overview: string;
  conventionsMarkdown: string;
  glossaryMarkdown: string;
}
export interface TeamContextDocument {
  doc_id: string;
  title: string;
  content: string;
  updated_at: string | null;
  source?: string;
}
export interface ResolvedTeamContextDocs {
  conventions: TeamContextDocument[];
  glossary: TeamContextDocument | null;
  refs: { conventions: TeamContextDocRef[]; glossary: TeamContextDocRef | null };
}
export interface TeamContextDocumentSource {
  toolIds: readonly string[];
  resolve: (db: DatabaseProvider, config?: TeamContextConfig) => Promise<ResolvedTeamContextDocs>;
  validate: (
    db: DatabaseProvider,
    input: { conventions: string[]; glossary: string | null },
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  candidates: (db: DatabaseProvider) => Promise<TeamContextCandidate[]>;
}
export async function readTeamContextConfig(): Promise<TeamContextConfig> {
  const [conventions, glossary, timezone, overview, conventionsMarkdown, glossaryMarkdown] = await Promise.all(
    [
      'team_context.conventions',
      'team_context.glossary',
      'team_context.timezone',
      'team_context.overview_markdown',
      'team_context.conventions_markdown',
      'team_context.glossary_markdown',
    ].map(getWorkspaceValue),
  );
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const ids = Array.isArray(conventions)
    ? conventions.filter((id): id is string => typeof id === 'string' && !!id.trim())
    : [];
  return {
    conventionIds: [...new Set(ids.map((id) => id.trim()))].slice(0, MAX_CONVENTION_DOCS),
    glossaryId: text(glossary) || null,
    timezone: text(timezone) && isValidTimeZone(text(timezone)) ? text(timezone) : null,
    overview: text(overview),
    conventionsMarkdown: text(conventionsMarkdown),
    glossaryMarkdown: text(glossaryMarkdown),
  };
}
export async function workspaceTimeZone() {
  return (await readTeamContextConfig()).timezone ?? DEFAULT_WORKSPACE_TIMEZONE;
}
export function teamContextDocumentSources() {
  return documentSources;
}
export async function resolveTeamContextDocs(
  db: DatabaseProvider,
  config?: TeamContextConfig,
): Promise<ResolvedTeamContextDocs> {
  const source = teamContextDocumentSources()[0];
  return source
    ? source.resolve(db, config)
    : { conventions: [], glossary: null, refs: { conventions: [], glossary: null } };
}
export async function validateTeamContextSelection(
  db: DatabaseProvider,
  input: { conventions: string[]; glossary: string | null },
) {
  const source = teamContextDocumentSources()[0];
  if (source) return source.validate(db, input);
  return input.conventions.length || input.glossary
    ? { ok: false as const, error: 'No team document source is enabled' }
    : { ok: true as const };
}
