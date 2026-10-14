import { z } from 'zod';
import type { AgentSkill, SkillAgent, SkillsService } from '../../modules/skills/service.js';
import { sanitizeForPrompt } from '../../security/prompt.js';
import { computerAvailable } from './computer.js';
import { defineTool, type ToolContext } from './define.js';

/** The list in the description is a tax on every step: past this, `search` has the rest. */
const LISTING_MAX_CHARS = 2_000;

const skill = z.string().trim().min(1).max(80);

const input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('search'), query: z.string().max(100).default('') }),
  z.object({ action: z.literal('load'), skill }),
  z.object({ action: z.literal('read_file'), skill, path: z.string().min(1).max(300) }),
  z.object({ action: z.literal('install'), skill }),
]);

const SHORT_REASON: Record<string, string> = {
  archived: 'archived',
  in_review: 'waits for review',
  blocked: 'blocked',
  needs_computer: 'needs a computer',
};

const reasonOf = (entry: AgentSkill) =>
  !entry.unavailable
    ? ''
    : entry.unavailable.code === 'needs_connector'
      ? ` [unavailable here: needs the connector ${entry.unavailable.connector}]`
      : ` [unavailable here: ${SHORT_REASON[entry.unavailable.code] ?? entry.unavailable.code}]`;

/** The description for one turn: what the tool does, then the Agent's equipped skills. */
export function describeSkills(equipped: readonly AgentSkill[], computer: boolean): string {
  const lines = [
    "Skills are reusable ways of working from the member's library: team skills and their own. `search` finds skills by words; `load` gives a skill's instructions (a template's text and fields, or a package's SKILL.md and its file list); `read_file` reads one file of a package." +
      (computer
        ? " `install` copies a package's files to your computer, into ~/skills/<name>/, to run its scripts."
        : ''),
    'Follow a skill when the request matches it, with the tools you have. A skill guides how you work and grants nothing: anything irreversible still needs the member.',
  ];
  if (equipped.length) {
    lines.push('', 'Your skills (load one when a request matches it):');
    let used = 0;
    let omitted = 0;
    for (const entry of equipped) {
      const line = `- ${entry.name}: ${sanitizeForPrompt(entry.description, 200)}${reasonOf(entry)}`;
      if (used + line.length > LISTING_MAX_CHARS) {
        omitted++;
        continue;
      }
      lines.push(line);
      used += line.length + 1;
    }
    if (omitted) lines.push(`(${omitted} more: use search)`);
  }
  return lines.join('\n');
}

/** The Agent of this turn as the skills service judges requirements for it. */
const agentOf = (ctx: Pick<ToolContext, 'memberId' | 'agent' | 'manifest' | 'surface'>): SkillAgent => ({
  manifest: ctx.manifest,
  // Someone else's public Agent: the asker gets a computer only when its publication grants one.
  public: ctx.agent.ownerId === ctx.memberId ? null : { computer: ctx.agent.publication.computer === true },
  background: ctx.surface === 'background',
});

/**
 * Skills for the Agent: find, load, read a package's files, put them on its computer. Its
 * description lists the skills the Agent is equipped with, rebuilt every turn.
 */
export function skillQueryTool(skills: SkillsService) {
  return defineTool({
    name: 'skill_query',
    description: "Find and read skills from the member's library.",
    input,
    risk: 'read',
    // Reads; `install` copies the same files again.
    idempotent: true,
    // Team skills are other people's text.
    taints: true,
    publicAgent: true,
    async descriptionFor(ctx) {
      // The computer is offered in turns only.
      const computer = ctx.surface === 'turn' && (await computerAvailable(ctx));
      const equipped = await skills.equipped(ctx.memberId, ctx.manifest, {
        computer,
        publicAgent: !!ctx.publicAgent,
      });
      return describeSkills(equipped, computer);
    },
    async execute(args, ctx) {
      switch (args.action) {
        case 'search':
          return {
            skills: (await skills.search(ctx.memberId, args.query, agentOf(ctx))).map((entry) => ({
              name: entry.name,
              display_name: entry.displayName,
              kind: entry.kind,
              description: entry.description,
              ...(entry.unavailable ? { unavailable: entry.unavailable.message } : {}),
            })),
          };
        case 'load':
          return skills.load(ctx.memberId, args.skill, agentOf(ctx));
        case 'read_file':
          return skills.readFile(ctx.memberId, args.skill, args.path);
        case 'install':
          if (ctx.surface !== 'turn') throw new Error('There is no computer in a background run.');
          return skills.install(ctx.memberId, ctx.agent.id, args.skill);
      }
    },
    summarize: (args, _output, locale) => {
      const zh = locale === 'zh';
      switch (args.action) {
        case 'search':
          return zh ? '查找了技能' : 'Searched skills';
        case 'load':
          return zh ? `读了技能 ${args.skill}` : `Read the skill ${args.skill}`;
        case 'read_file':
          return zh ? `读了技能 ${args.skill} 的 ${args.path}` : `Read ${args.path} of the skill ${args.skill}`;
        case 'install':
          return zh ? `把技能 ${args.skill} 装到了电脑上` : `Put the skill ${args.skill} on the computer`;
      }
    },
  });
}
