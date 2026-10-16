import { interpolate } from '@greenhouse/utils/i18n';
import { z } from 'zod';
import {
  SKILL_DESCRIPTION_MAX,
  SKILL_DISPLAY_NAME_MAX,
  SKILL_SPACES,
  SKILL_TEMPLATE_BODY_MAX,
  SKILL_VARIABLES_MAX,
  skillNameSchema,
  skillRequirementsSchema,
  skillVariableSchema,
} from '@greenhouse/contract';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { SkillsService } from '../../modules/skills/service.js';
import { variablesProblem } from '../../modules/skills/template.js';
import { defineTool } from './define.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The template a card proposes, as the member will save it. */
const proposalSchema = z.object({
  // Checked against skillNameSchema in execute: its Unicode pattern is no JSON Schema for a model.
  name: z.string().trim().min(1).max(64),
  display_name: z.string().trim().max(SKILL_DISPLAY_NAME_MAX).optional(),
  description: z.string().trim().min(1).max(SKILL_DESCRIPTION_MAX),
  body: z.string().trim().min(1).max(SKILL_TEMPLATE_BODY_MAX),
  variables: z.array(skillVariableSchema).max(SKILL_VARIABLES_MAX).default([]),
  requirements: skillRequirementsSchema.default({ computer: false, connectors: [] }),
  space: z.enum(SKILL_SPACES).default('personal'),
});

/**
 * An Agent proposing to save the conversation's way of working as a template skill (原
 * task_capture). Like `self`, a proposal changes nothing: the skill is saved, as the member,
 * only when they accept the card.
 */
export function skillMutationTool(skills: SkillsService) {
  return defineTool({
    name: 'skill_mutation',
    description:
      "Propose saving a way of working from this conversation as a template skill in the member's library, so they can run it again with `/`: instructions with {{placeholders}} for what changes each time, and a field for each (the same fields as ask_user). Use it when the member asks to save how you did something, or offer it after a task they will clearly repeat. Nothing is saved until they accept the card; say so in one line.",
    input: proposalSchema.extend({ reason: z.string().trim().min(1).max(500) }),
    risk: 'read',
    surfaces: ['turn'],
    async execute(args, ctx) {
      const { reason, ...skill } = args;
      const name = skillNameSchema.safeParse(skill.name);
      if (!name.success) throw new Error(`"${skill.name}" cannot be a skill name: ${name.error.issues[0]?.message}`);
      const problem = variablesProblem(skill.body, skill.variables);
      if (problem) throw new Error(problem);
      const label = skill.display_name || skill.name;
      const request = await ctx.raise({
        kind: 'proposal',
        subject: 'skill_save',
        title:
          ctx.locale === 'zh'
            ? interpolate('zh', '{name} 想把这个做法存为技能：{label}', { name: ctx.agent.name, label })
            : `${ctx.agent.name} proposes saving this as a skill: ${label}`,
        payload: {
          skill,
          reason,
          details: [
            { label: ctx.locale === 'zh' ? '技能' : 'Skill', value: label },
            { label: ctx.locale === 'zh' ? '说明' : 'Description', value: skill.description },
            { label: ctx.locale === 'zh' ? '做法' : 'Instructions', value: skill.body, format: 'markdown' },
            ...skill.variables.map((field) => ({
              label: field.label,
              value: field.required
                ? ctx.locale === 'zh'
                  ? '必填'
                  : 'Required'
                : ctx.locale === 'zh'
                  ? '可选'
                  : 'Optional',
            })),
          ],
        },
        waits: false,
        expiresInMs: WEEK_MS,
      });
      return { status: 'proposed', request_id: request.id };
    },
    async decide(request, ctx) {
      const zh = ctx.locale === 'zh';
      const proposal = proposalSchema.safeParse(request.payload.skill);
      const name = proposal.success ? proposal.data.name : '';
      if (request.status === 'rejected')
        return { line: zh ? `没有存为技能：${name}` : `Not saved as a skill: ${name}`, note: null };
      if (request.status !== 'approved') {
        return { line: zh ? '存为技能的提议已过期' : 'The proposal to save a skill expired', note: null };
      }
      try {
        if (!proposal.success || !skillNameSchema.safeParse(proposal.data.name).success) {
          throw new Error('The proposal is not a valid template.');
        }
        const saved = await skills.saveTemplate(ctx.memberId, proposal.data);
        // The transcript line is enough; waking the Agent would only get a thank-you.
        return { line: zh ? `已存为技能 /${saved.name}` : `Saved as the skill /${saved.name}`, note: null };
      } catch (error) {
        const message = toErrorMessage(error);
        return {
          line: zh ? `没能存为技能：${message}` : `Could not save the skill: ${message}`,
          note: `The member accepted saving the skill "${name}", but it failed: ${message} Propose it again with that fixed if it still matters.`,
        };
      }
    },
    summarize: (args, _output, locale) =>
      locale === 'zh' ? `提议存为技能：${args.name}` : `Proposed saving a skill: ${args.name}`,
  });
}
