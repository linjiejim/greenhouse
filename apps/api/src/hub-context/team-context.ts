/**
 * Team context for a member's agent — the three MCP resources
 * (`greenhouse://context/overview|conventions|glossary`) and the compact
 * `team_context` tool bundle for clients that only speak tools.
 *
 * Everything is cut to the caller's reach: `reachable` is the token's MCP tool
 * set (scopes ∩ the member's own permissions), so a grant without
 * `mcp:knowledge` gets no conventions or glossary, one without `mcp:skills` no
 * skills or prompts, one without `mcp:tables` no bases. Conventions and
 * glossary are team-visible documents an admin picked (hub-context/settings.ts);
 * each is still read through `resolveKbAccess` for this member.
 */

import type { DatabaseProvider, KnowledgeDoc } from '@greenhouse/db';
import type { ActorContext } from '@greenhouse/platform-kernel';
import { allMcpResourceGroups, isRetiredMcpResourceGroup } from '@greenhouse/types/mcp';
import { DATA_CATALOG_TOOL, TEAM_CONTEXT_TOOL, TEAM_CONTEXT_URIS } from '@greenhouse/types/hub-context';
import { getToolMeta } from '../tools/registry.js';
import { canRead, resolveKbAccess } from '../knowledge/access.js';
import { getWorkspaceValue } from '../settings/workspace-config.js';
import { EXTENSIONS } from '../extensions/index.js';
import { resolveTeamContextDocs } from './settings.js';
import { listTeamPrompts, promptsReachable } from './prompts.js';
import { buildDataCatalog } from './catalog.js';

export interface TeamContextCaller {
  db: DatabaseProvider;
  userId: string;
  role: string;
  /** The MCP tools this caller reaches (see module doc). */
  reachable: ReadonlySet<string>;
  /** Platform actor for the Tables listing (the delegated agent on MCP). */
  actor: ActorContext;
}

export interface ContextResourceDescriptor {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: 'text/markdown';
}

export interface ContextResourceContent {
  uri: string;
  mimeType: 'text/markdown';
  text: string;
}

/** In the tool bundle each document is cut here; the resource carries it whole. */
const BUNDLE_DOC_CHARS = 3_000;
const BUNDLE_PROMPTS = 40;

/** What each core resource group is, for the overview (extension groups use the extension's own words). */
const GROUP_PURPOSE: Record<string, string> = {
  knowledge: 'Knowledge base: team and personal documents',
  files: 'Files: the team cabinet and your own files',
  projects: 'Projects and their tasks',
  tables: 'Tables: structured team data (bases, tables, records)',
  skills: 'SkillHub: team skills and saved prompts (also offered as MCP prompts)',
  chat: 'Your Greenhouse chat history (read-only)',
  automation: 'Your scheduled automations (read-only)',
  feedback: 'Issues & requests: report frictions and feature requests to the team',
  services: 'Paid services: web search, page reads, image analysis and generation (metered to you)',
  computer: 'Your cloud computer (runs commands; billed per minute)',
  reports:
    "Report templates: the team's required report / deck formats (report_templates), rendered to PDF / DOCX / PPTX into Files (report_render)",
};

function groupPurpose(group: string): string {
  if (GROUP_PURPOSE[group]) return GROUP_PURPOSE[group]!;
  const ext = EXTENSIONS.find((entry) => entry.mcpGroups?.includes(group));
  return ext ? `${ext.name}${ext.description ? `: ${ext.description}` : ''}` : group;
}

export interface GrantedGroup {
  group: string;
  purpose: string;
  read: string[];
  write: string[];
}

/** The caller's tools, by MCP resource group, in consent order. */
export function grantedGroups(reachable: ReadonlySet<string>): GrantedGroup[] {
  const byGroup = new Map<string, GrantedGroup>();
  for (const toolId of reachable) {
    const surface = getToolMeta(toolId)?.surface;
    const group = typeof surface?.mcp === 'string' ? surface.mcp : null;
    if (!group || isRetiredMcpResourceGroup(group)) continue;
    const entry = byGroup.get(group) ?? { group, purpose: groupPurpose(group), read: [], write: [] };
    (surface?.proxy === 'write' ? entry.write : entry.read).push(toolId);
    byGroup.set(group, entry);
  }
  const order = allMcpResourceGroups();
  return [...byGroup.values()]
    .map((entry) => ({ ...entry, read: entry.read.sort(), write: entry.write.sort() }))
    .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}

/** The reports group (v1.7 report templates): templates to follow before writing a report. */
function reportsReachable(reachable: ReadonlySet<string>): boolean {
  return reachable.has('report_templates');
}

function knowledgeReachable(reachable: ReadonlySet<string>): boolean {
  return reachable.has('knowledge_query');
}

async function readableDocs(caller: TeamContextCaller, docs: KnowledgeDoc[]): Promise<KnowledgeDoc[]> {
  const allowed = await Promise.all(
    docs.map(async (doc) => canRead(await resolveKbAccess(caller.db, doc, caller.userId))),
  );
  return docs.filter((_, index) => allowed[index]);
}

/** The conventions and glossary this caller may read (empty when the grant has no knowledge). */
async function contextDocs(caller: TeamContextCaller) {
  if (!knowledgeReachable(caller.reachable)) return { conventions: [], glossary: null };
  const resolved = await resolveTeamContextDocs(caller.db);
  const [conventions, glossary] = await Promise.all([
    readableDocs(caller, resolved.conventions),
    resolved.glossary ? readableDocs(caller, [resolved.glossary]) : Promise.resolve([]),
  ]);
  return { conventions, glossary: glossary[0] ?? null };
}

function docSource(doc: KnowledgeDoc): string {
  const updated = doc.updated_at ? new Date(doc.updated_at).toISOString().slice(0, 10) : 'unknown';
  return `Source: greenhouse://knowledge/doc/${encodeURIComponent(doc.doc_id)} · updated ${updated}`;
}

function conventionsMarkdown(docs: KnowledgeDoc[]): string {
  return [
    '# Team conventions',
    '',
    'How this team works. Follow these unless your user says otherwise.',
    ...docs.flatMap((doc) => ['', `## ${doc.title}`, '', docSource(doc), '', doc.content.trim()]),
    '',
  ].join('\n');
}

function glossaryMarkdown(doc: KnowledgeDoc): string {
  return ['# Glossary', '', `## ${doc.title}`, '', docSource(doc), '', doc.content.trim(), ''].join('\n');
}

async function productName(): Promise<string> {
  const name = await getWorkspaceValue('branding.product_name');
  return typeof name === 'string' && name.trim() ? name.trim() : 'Greenhouse';
}

async function memberLabel(caller: TeamContextCaller): Promise<string> {
  const user = await caller.db.users.getById(caller.userId);
  return user?.nickname || user?.email || caller.userId;
}

async function dataSummary(caller: TeamContextCaller) {
  const catalog = await buildDataCatalog({
    db: caller.db,
    actor: caller.actor,
    reachable: caller.reachable,
    counts: false,
  });
  return {
    bases: catalog.bases.length,
    // Every table, not just the ones the catalog lists per base.
    tables: catalog.bases.reduce((sum, base) => sum + base.table_count, 0),
    truncated: catalog.truncated || catalog.bases.some((base) => base.tables_truncated),
    extensions: catalog.extensions.map((ext) => ext.name),
  };
}

async function overviewMarkdown(caller: TeamContextCaller): Promise<string> {
  const [product, member, groups, docs, prompts, data] = await Promise.all([
    productName(),
    memberLabel(caller),
    Promise.resolve(grantedGroups(caller.reachable)),
    contextDocs(caller),
    listTeamPrompts(caller.db, { userId: caller.userId, role: caller.role }, caller.reachable),
    dataSummary(caller),
  ]);
  const skills = prompts.filter((prompt) => prompt.name.startsWith('skill-')).length;
  const saved = prompts.length - skills;
  const lines = [
    `# ${product} — what this team's Greenhouse offers your agent`,
    '',
    `You are connected as ${member} (${caller.role === 'super' ? 'administrator' : 'member'}). You act with their permissions, and every write is recorded in their name.`,
    '',
    '## What this connection can reach',
    '',
    ...(groups.length > 0
      ? groups.map(
          (entry) =>
            `- **${entry.group}** — ${entry.purpose}. Read: ${entry.read.join(', ') || '—'}; write: ${entry.write.join(', ') || '—'}`,
        )
      : ['- Nothing yet: your user granted this connection no resource groups.']),
    '',
    '## Team context',
    '',
    docs.conventions.length > 0
      ? `- Conventions: ${docs.conventions.map((doc) => `"${doc.title}"`).join(', ')} — read ${TEAM_CONTEXT_URIS.conventions}`
      : knowledgeReachable(caller.reachable)
        ? '- Conventions: none set up by an administrator yet.'
        : '- Conventions and glossary: this connection has no knowledge access.',
    ...(knowledgeReachable(caller.reachable)
      ? [
          docs.glossary
            ? `- Glossary: "${docs.glossary.title}" — read ${TEAM_CONTEXT_URIS.glossary}`
            : '- Glossary: none set up by an administrator yet.',
        ]
      : []),
    '',
    '## Skills and prompts',
    '',
    promptsReachable(caller.reachable)
      ? `- ${skills} SkillHub skill(s) and ${saved} saved prompt(s), offered as MCP prompts (\`skill-<name>\`, \`prompt-<id>\`); skill_query finds and downloads skills.`
      : '- This connection has no SkillHub access.',
    '',
    '## Data sources',
    '',
    data.bases > 0 || data.extensions.length > 0
      ? `- ${data.bases} Tables base(s) with ${data.tables} table(s)${data.extensions.length > 0 ? `, plus ${data.extensions.join(', ')}` : ''}. Call ${DATA_CATALOG_TOOL} for the list and how to query each.` +
        (data.truncated
          ? ` It lists the first tables of very large bases (and the first bases) only; tables_query action=tables.list base_id=… has the rest.`
          : '')
      : `- None this connection can read. Call ${DATA_CATALOG_TOOL} to check.`,
    '',
    '## Working agreements',
    '',
    `- Call ${TEAM_CONTEXT_TOOL} (or read this resource) at the start of a new task.`,
    '- Before changing data other people rely on, make sure your user wants the change.',
    '- A delete first returns a preview; send it again with confirm:true only after your user agrees.',
    ...(reportsReachable(caller.reachable)
      ? [
          '- Writing a report or deck? Call report_templates list first and follow the team template (report_templates validate checks it; report_render saves it into Files).',
        ]
      : []),
    '- Ran into something confusing or broken? Report it with log_friction; ideas go to feature_request.',
    '',
  ];
  return lines.join('\n');
}

/** The context resources this caller can read, for `resources/list`. */
export async function listContextResources(caller: TeamContextCaller): Promise<ContextResourceDescriptor[]> {
  const docs = await contextDocs(caller);
  const out: ContextResourceDescriptor[] = [
    {
      uri: TEAM_CONTEXT_URIS.overview,
      name: 'team-context-overview',
      title: 'What this Greenhouse offers',
      description: 'Modules, what this connection can reach, team context and data sources. Read it first.',
      mimeType: 'text/markdown',
    },
  ];
  if (docs.conventions.length > 0) {
    out.push({
      uri: TEAM_CONTEXT_URIS.conventions,
      name: 'team-conventions',
      title: 'Team conventions',
      description: `How this team works (${docs.conventions.map((doc) => doc.title).join(', ')})`,
      mimeType: 'text/markdown',
    });
  }
  if (docs.glossary) {
    out.push({
      uri: TEAM_CONTEXT_URIS.glossary,
      name: 'team-glossary',
      title: 'Glossary',
      description: `The team's terms (${docs.glossary.title})`,
      mimeType: 'text/markdown',
    });
  }
  return out;
}

export function isContextResourceUri(uri: string): boolean {
  return uri.startsWith('greenhouse://context/');
}

/** Read one context resource, or undefined when this caller has no such resource. */
export async function readContextResource(
  caller: TeamContextCaller,
  uri: string,
): Promise<ContextResourceContent | undefined> {
  if (uri === TEAM_CONTEXT_URIS.overview) {
    return { uri, mimeType: 'text/markdown', text: await overviewMarkdown(caller) };
  }
  if (uri === TEAM_CONTEXT_URIS.conventions) {
    const { conventions } = await contextDocs(caller);
    return conventions.length > 0
      ? { uri, mimeType: 'text/markdown', text: conventionsMarkdown(conventions) }
      : undefined;
  }
  if (uri === TEAM_CONTEXT_URIS.glossary) {
    const { glossary } = await contextDocs(caller);
    return glossary ? { uri, mimeType: 'text/markdown', text: glossaryMarkdown(glossary) } : undefined;
  }
  return undefined;
}

function bundleDoc(doc: KnowledgeDoc, fullUri: string) {
  const content = doc.content.trim();
  const truncated = content.length > BUNDLE_DOC_CHARS;
  return {
    title: doc.title,
    doc_id: doc.doc_id,
    updated_at: doc.updated_at ? new Date(doc.updated_at).toISOString() : null,
    content: truncated ? `${content.slice(0, BUNDLE_DOC_CHARS)}…` : content,
    ...(truncated
      ? { truncated: true, full_text: `${fullUri} or knowledge_query action get doc_id=${doc.doc_id}` }
      : {}),
  };
}

/** The `team_context` tool result: the same bundle as the resources, compactly. */
export async function buildTeamContextBundle(caller: TeamContextCaller) {
  const [product, member, docs, prompts, data] = await Promise.all([
    productName(),
    memberLabel(caller),
    contextDocs(caller),
    listTeamPrompts(caller.db, { userId: caller.userId, role: caller.role }, caller.reachable),
    dataSummary(caller),
  ]);
  return {
    workspace: product,
    you: { name: member, role: caller.role === 'super' ? 'administrator' : 'member' },
    access: grantedGroups(caller.reachable),
    conventions: knowledgeReachable(caller.reachable)
      ? docs.conventions.map((doc) => bundleDoc(doc, TEAM_CONTEXT_URIS.conventions))
      : null,
    glossary: docs.glossary ? bundleDoc(docs.glossary, TEAM_CONTEXT_URIS.glossary) : null,
    prompts: promptsReachable(caller.reachable)
      ? {
          total: prompts.length,
          items: prompts.slice(0, BUNDLE_PROMPTS).map((prompt) => ({
            name: prompt.name,
            title: prompt.title,
            description: prompt.description,
            arguments: prompt.arguments.map((arg) => arg.name),
          })),
          how: 'Use them as MCP prompts if your client supports prompts; otherwise skill_query skills.download fetches a skill.',
        }
      : null,
    data_sources: {
      tables_bases: data.bases,
      tables: data.tables,
      ...(data.truncated
        ? {
            truncated: true,
            note: `${DATA_CATALOG_TOOL} lists the first tables per base; tables_query tables.list has all of them.`,
          }
        : {}),
      extensions: data.extensions,
      how: `Call ${DATA_CATALOG_TOOL} for every source and the tool to query it.`,
    },
    notes: [
      knowledgeReachable(caller.reachable)
        ? docs.conventions.length === 0
          ? 'No team conventions are set up yet.'
          : 'Follow the conventions unless your user says otherwise.'
        : 'This connection has no knowledge access, so conventions and glossary are not included.',
      'Before changing data other people rely on, make sure your user wants the change; deletes preview first.',
      ...(reportsReachable(caller.reachable)
        ? ['For a report or deck, call report_templates list first and follow the team template.']
        : []),
    ],
  };
}
