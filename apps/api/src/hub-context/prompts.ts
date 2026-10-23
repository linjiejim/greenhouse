/**
 * MCP prompts — the team's reusable instructions, offered to a member's agent
 * as MCP prompts (slash commands in most clients):
 *
 *   • `skill-<name>`: a SkillHub skill the member may download (the quarantine
 *     rule of `downloadSkill`, see skills/center.ts). The prompt is the SKILL.md
 *     body; its variables become prompt arguments.
 *   • `prompt-<id>`: one of the member's Tasks (SkillHub › My prompts — their own
 *     plus the ones shared with the team). Its declared variables are the
 *     arguments.
 *
 * Both are gated on the `skills` resource group: a grant that cannot reach
 * `skill_query` gets no prompts. Filled `{{placeholders}}` are substituted; an
 * unfilled one stays visible, exactly like a Task run in the app.
 */

import { parse as parseYaml } from 'yaml';
import type { DatabaseProvider, SkillRow, UserPromptRow } from '@greenhouse/db';
import type { TaskVariable } from '@greenhouse/types/tasks';
import { safeJsonParse } from '@greenhouse/utils/json';
import { downloadSkill, skillUsableBy, type Actor } from '../skills/center.js';
import type { SkillFile } from '../skills/bundle.js';

export interface TeamPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface TeamPromptDescriptor {
  name: string;
  title: string;
  description: string;
  arguments: TeamPromptArgument[];
}

export interface TeamPromptMessage {
  role: 'user';
  content: { type: 'text'; text: string };
}

export interface TeamPrompt {
  description: string;
  messages: TeamPromptMessage[];
}

/** Skills listed per request; SkillHub is a team catalogue, not an archive. */
const MAX_SKILLS = 200;
const SKILL_PREFIX = 'skill-';
const PROMPT_PREFIX = 'prompt-';
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g;

/** The skills group carries both kinds (SkillHub hosts skills and My prompts). */
export function promptsReachable(reachable: ReadonlySet<string>): boolean {
  return reachable.has('skill_query');
}

function splitFrontmatter(markdown: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!match) return { frontmatter: {}, body: markdown };
  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(match[1]!) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) frontmatter = parsed as Record<string, unknown>;
  } catch {
    // A malformed frontmatter is the author's to fix; the body still serves.
  }
  return { frontmatter, body: markdown.slice(match[0].length) };
}

function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER_RE)].map((match) => match[1]!))];
}

/**
 * A skill's arguments: the frontmatter `variables:` list (`key` or `name`, plus
 * optional `description` / `label` / `required`), else every `{{placeholder}}`
 * in the body.
 */
export function skillArguments(skillMd: string): TeamPromptArgument[] {
  const { frontmatter, body } = splitFrontmatter(skillMd);
  const declared = Array.isArray(frontmatter.variables) ? frontmatter.variables : null;
  if (declared) {
    return declared.flatMap((entry): TeamPromptArgument[] => {
      if (typeof entry === 'string') return [{ name: entry }];
      if (!entry || typeof entry !== 'object') return [];
      const record = entry as Record<string, unknown>;
      const name = typeof record.key === 'string' ? record.key : typeof record.name === 'string' ? record.name : null;
      if (!name) return [];
      const description =
        typeof record.description === 'string'
          ? record.description
          : typeof record.label === 'string'
            ? record.label
            : undefined;
      return [
        { name, ...(description ? { description } : {}), ...(record.required === true ? { required: true } : {}) },
      ];
    });
  }
  return placeholders(body).map((name) => ({ name }));
}

function taskArguments(row: UserPromptRow): TeamPromptArgument[] {
  const variables = safeJsonParse(row.variables, []) as TaskVariable[];
  return (Array.isArray(variables) ? variables : [])
    .filter((variable) => variable && typeof variable.key === 'string')
    .map((variable) => ({
      name: variable.key,
      description: [variable.label, variable.description, variable.example ? `e.g. ${variable.example}` : '']
        .filter(Boolean)
        .join(' — '),
      ...(variable.required ? { required: true } : {}),
    }));
}

/** Replace filled placeholders; unfilled ones stay as `{{key}}` for the agent to ask about. */
export function fillPlaceholders(text: string, args: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER_RE, (whole, key: string) => {
    const value = args[key];
    return typeof value === 'string' && value.length > 0 ? value : whole;
  });
}

function skillMdOf(files: readonly SkillFile[]): string | null {
  const file = files.find((entry) => entry.path === 'SKILL.md');
  if (!file) return null;
  return file.encoding === 'base64' ? Buffer.from(file.content, 'base64').toString('utf8') : file.content;
}

// Parsed arguments per stored version — a version's bundle is immutable.
const argumentCache = new Map<string, TeamPromptArgument[]>();

async function cachedSkillArguments(
  db: DatabaseProvider,
  skill: SkillRow,
  actor: Actor,
): Promise<TeamPromptArgument[]> {
  const key = `${skill.id}@${skill.latest_version}`;
  const hit = argumentCache.get(key);
  if (hit) return hit;
  const download = await downloadSkill(db, skill.name, undefined, { meter: false, actor });
  const skillMd = download.ok ? skillMdOf(download.files) : null;
  const args = skillMd ? skillArguments(skillMd) : [];
  if (download.ok) argumentCache.set(key, args);
  return args;
}

async function usableSkills(db: DatabaseProvider, actor: Actor): Promise<SkillRow[]> {
  const rows = await db.skills.list({ status: 'active', limit: MAX_SKILLS });
  return rows.filter((skill) => skillUsableBy(skill, actor));
}

export async function listTeamPrompts(
  db: DatabaseProvider,
  actor: Actor,
  reachable: ReadonlySet<string>,
): Promise<TeamPromptDescriptor[]> {
  if (!promptsReachable(reachable)) return [];
  const [skills, tasks] = await Promise.all([usableSkills(db, actor), db.userPrompts.listForUser(actor.userId)]);
  const skillPrompts = await Promise.all(
    skills.map(
      async (skill): Promise<TeamPromptDescriptor> => ({
        name: `${SKILL_PREFIX}${skill.name}`,
        title: skill.display_name || skill.name,
        description: `SkillHub skill ${skill.name}@${skill.latest_version}: ${skill.description}`,
        arguments: await cachedSkillArguments(db, skill, actor),
      }),
    ),
  );
  const taskPrompts = tasks.map(
    (row): TeamPromptDescriptor => ({
      name: `${PROMPT_PREFIX}${row.id}`,
      title: row.title,
      description: row.description?.trim() || `Saved prompt "${row.title}" from SkillHub › My prompts`,
      arguments: taskArguments(row),
    }),
  );
  return [...skillPrompts, ...taskPrompts];
}

/** Resolve one prompt by name, or null when this caller has no such prompt. */
export async function getTeamPrompt(
  db: DatabaseProvider,
  actor: Actor,
  reachable: ReadonlySet<string>,
  name: string,
  args: Readonly<Record<string, string>>,
): Promise<TeamPrompt | null> {
  if (!promptsReachable(reachable)) return null;

  if (name.startsWith(SKILL_PREFIX)) {
    const skillName = name.slice(SKILL_PREFIX.length);
    const skill = await db.skills.getByName(skillName);
    if (!skill || skill.status !== 'active' || !skillUsableBy(skill, actor)) return null;
    const download = await downloadSkill(db, skill.name, undefined, { meter: false, actor });
    if (!download.ok) return null;
    const skillMd = skillMdOf(download.files);
    if (!skillMd) return null;
    const { body } = splitFrontmatter(skillMd);
    const others = download.files.map((file) => file.path).filter((path) => path !== 'SKILL.md');
    const header = [
      `Team skill "${skill.display_name || skill.name}" (${skill.name}@${download.version.version}) from Greenhouse SkillHub. Follow it for this task.`,
      others.length > 0
        ? `It also ships ${others.slice(0, 20).join(', ')}${others.length > 20 ? ', …' : ''} — fetch them with skill_query action skills.download name=${skill.name} when you need them.`
        : null,
    ]
      .filter(Boolean)
      .join('\n');
    return {
      description: skill.description,
      messages: [
        { role: 'user', content: { type: 'text', text: `${header}\n\n${fillPlaceholders(body.trim(), args)}` } },
      ],
    };
  }

  if (name.startsWith(PROMPT_PREFIX)) {
    const id = Number(name.slice(PROMPT_PREFIX.length));
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const row = await db.userPrompts.getById(id);
    // Their own, or one shared with the team — the same set the picker lists.
    if (!row || (row.user_id !== actor.userId && !row.is_global)) return null;
    return {
      description: row.description?.trim() || row.title,
      messages: [{ role: 'user', content: { type: 'text', text: fillPlaceholders(row.content, args) } }],
    };
  }
  return null;
}
