/**
 * MCP prompts — the team's reusable instructions, offered to a member's agent
 * as MCP prompts (slash commands in most clients):
 *
 *   • `skill-<name>`: a SkillHub skill the member may download (the quarantine
 *     rule of `downloadSkill`, see skills/center.ts). The prompt is the SKILL.md
 *     body; its variables become prompt arguments.
 * The plugin gates these on reachable `skill_query`; saved prompt rendering
 * remains in core. Filled `{{placeholders}}` are substituted; an
 * unfilled one stays visible, exactly like a Task run in the app.
 */

import { parse as parseYaml } from 'yaml';
import type {
  DatabaseProvider,
  TeamPromptArgument,
  TeamPromptDescriptor,
  TeamPrompt,
} from '@greenhouse/api/extension-kit';
import type { SkillRow } from './schema.js';
import { services } from './services.js';
import { downloadSkill, skillUsableBy, type Actor } from './skills/center.js';
import type { SkillFile } from './skills/bundle.js';

/** Skills listed per request; SkillHub is a team catalogue, not an archive. */
const MAX_SKILLS = 200;
const SKILL_PREFIX = 'skill-';
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g;

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
  const rows = await services(db).skills.list({ status: 'active', limit: MAX_SKILLS });
  return rows.filter((skill) => skillUsableBy(skill, actor));
}

export async function listSkillPrompts(db: DatabaseProvider, actor: Actor): Promise<TeamPromptDescriptor[]> {
  const skills = await usableSkills(db, actor);
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
  return skillPrompts;
}

/** Resolve one prompt by name, or null when this caller has no such prompt. */
export async function getSkillPrompt(
  db: DatabaseProvider,
  actor: Actor,
  name: string,
  args: Readonly<Record<string, string>>,
): Promise<TeamPrompt | null> {
  if (name.startsWith(SKILL_PREFIX)) {
    const skillName = name.slice(SKILL_PREFIX.length);
    const skill = await services(db).skills.getByName(skillName);
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

  return null;
}
