/**
 * Skill runs in the transcript. A member's own `/` run enters the turn as their request: the
 * template's text with their values, or the package's SKILL.md with its file list, fenced as
 * instructions from the member rather than data. Someone else's run (in a room) is only named.
 * A skill that can no longer run (archived, held for review, blocked, gone) is named with that,
 * and its text stays out of every later turn.
 */

import { and, eq, inArray, or } from 'drizzle-orm';
import { getDb, members, skills, skillVersions, type Message, type Skill, type SkillVersion } from '@greenhouse/db';
import { sanitizeForPrompt } from '../../security/prompt.js';
import { visibleTo } from './access.js';
import { skillHome } from './computer.js';
import { fillTemplate } from './template.js';

const BODY_MAX = 32_000;

/** Text inside a block can never open or close one. */
const inBlock = (text: string, max = BODY_MAX) =>
  sanitizeForPrompt(text, max).replace(/<(\/?)skill_run/gi, '‹$1skill_run');

/** Why a skill the member ran cannot run now, or null. */
function stopped(skill: Skill): string | null {
  if (skill.archivedAt) return 'it was archived';
  if (skill.scanStatus === 'blocked') return 'it was confirmed malicious';
  if (skill.scanStatus !== 'clean') return 'its security scan holds it for review';
  return null;
}

/** The block that carries a run: the instructions as the member's request. */
export function runBlock(skill: Skill, version: SkillVersion, values: Record<string, string>): string {
  const name = skill.name;
  const lines = [
    `<skill_run name="${name}" version="${version.version}" note="The member ran this skill from their library: the text below is their request for this turn. Follow it with the tools you have.">`,
    inBlock(skill.kind === 'template' ? fillTemplate(version.body, values) : version.body),
  ];
  const empty = skill.kind === 'template' ? version.variables.filter((field) => !values[field.key]) : [];
  if (empty.length) {
    lines.push(
      '',
      `Left empty: ${empty.map((field) => `${field.key} (${inBlock(field.label, 80)})`).join(', ')}. Use your judgment, or ask if it matters.`,
    );
  }
  const files = version.files.filter((file) => file.path !== 'SKILL.md');
  if (files.length) {
    lines.push(
      '',
      `Files of this package: ${files.map((file) => inBlock(file.path, 200)).join(', ')}. Read one with skill_query (read_file); with a computer, skill_query (install) copies them all to ~/${skillHome(name)}/.`,
    );
  }
  lines.push('</skill_run>');
  return lines.join('\n');
}

/** The text each skill run among these messages adds for the asker, by message id. */
export async function skillRuns(rows: readonly Message[], askerId: string): Promise<Map<string, string>> {
  const runs = rows.filter((row) => row.role === 'user' && row.skill);
  if (!runs.length) return new Map();
  const db = getDb();
  const ids = [...new Set(runs.map((row) => row.skill!.skillId))];
  const [asker] = await db.select({ id: members.id, role: members.role }).from(members).where(eq(members.id, askerId));
  const found = new Map((await db.select().from(skills).where(inArray(skills.id, ids))).map((row) => [row.id, row]));
  const visible = new Set(
    asker
      ? (
          await db
            .select({ id: skills.id })
            .from(skills)
            .where(and(inArray(skills.id, ids), visibleTo(asker)))
        ).map((row) => row.id)
      : [],
  );
  const own = runs.filter((row) => row.authorMemberId === askerId && visible.has(row.skill!.skillId));
  const versions = own.length
    ? await db
        .select()
        .from(skillVersions)
        .where(
          or(
            ...own.map((row) =>
              and(
                eq(skillVersions.skillId, row.skill!.skillId),
                eq(skillVersions.version, row.skill!.version ?? found.get(row.skill!.skillId)!.latestVersion),
              ),
            ),
          ),
        )
    : [];
  const out = new Map<string, string>();
  for (const row of runs) {
    const ran = row.skill!;
    const skill = found.get(ran.skillId);
    if (row.authorMemberId !== askerId) {
      out.set(row.id, skill ? `(ran the skill "${skill.name}")` : '(ran a skill)');
      continue;
    }
    const version = versions.find(
      (entry) => entry.skillId === ran.skillId && entry.version === (ran.version ?? skill?.latestVersion),
    );
    if (!skill || !visible.has(skill.id) || !version) {
      out.set(row.id, '(ran a skill that is no longer available; it did not run)');
      continue;
    }
    const why = stopped(skill);
    out.set(
      row.id,
      why
        ? `(ran the skill "${skill.name}"; it cannot run any more: ${why})`
        : runBlock(skill, version, ran.variables ?? {}),
    );
  }
  return out;
}
