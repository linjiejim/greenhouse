import { z } from 'zod';
import { createAgentInputSchema, updateAgentInputSchema, type AgentManifest } from '@greenhouse/contract';
import { PLANT_IDS, PLANT_TINTS } from '@greenhouse/types';
import { getDb, members } from '@greenhouse/db';
import { eq } from 'drizzle-orm';
import type { AgentsService } from '../../modules/agents/service.js';
import { ApiError } from '../../http/errors.js';
import { defineTool } from './define.js';
import { fence } from '../../security/prompt.js';

const avatar = z.object({ plant: z.enum(PLANT_IDS), tint: z.enum(PLANT_TINTS).optional() });
export function agentMutationTool(agents: AgentsService) {
  return defineTool({
    name: 'agent_mutation',
    description:
      'Create one of the member’s private Agents or update a private Agent’s profile, instructions, abilities (tools/connectors/write), attached readable knowledge folder_ids, equipped skills and allowed model. Runs immediately with receipt and undo. No publishing or sharing. For your own instructions use self instead. A recurring mail summary also needs schedule_mutation; creating an Agent alone does not schedule it.',
    input: z.discriminatedUnion('action', [
      createAgentInputSchema.omit({ template_key: true }).extend({
        action: z.literal('create'),
        name: createAgentInputSchema.shape.name.unwrap(),
        avatar: avatar.optional(),
      }),
      updateAgentInputSchema.extend({
        action: z.literal('update'),
        id: z.string().min(1).max(64),
        avatar: avatar.optional(),
      }),
    ]),
    risk: 'write',
    surfaces: ['turn'],
    callRisk: async () => 'tier1',
    available: (ctx) => !ctx.publicAgent,
    async turnContext(ctx) {
      const all = await agents.list(ctx.memberId, 'mine');
      return '<private_agents>\n' + all.map((a) => `${a.id}: ${fence(a.name, 80)}`).join('\n') + '\n</private_agents>';
    },
    async guard(args, ctx) {
      if (!ctx.conversation || ctx.conversation.kind === 'room' || ctx.agent.ownerId !== ctx.memberId)
        throw new ApiError(403, 'private_conversation_required', 'Manage private Agents in your own conversation.');
      // Serialize the per-member Agent limit, including concurrent creates by this member.
      await getDb().select({ id: members.id }).from(members).where(eq(members.id, ctx.memberId)).for('update');
      if (args.action === 'update')
        await agents.privateMutationTarget(ctx.memberId, args.id, ctx.agent.id, args.instructions);
    },
    async before(args, ctx) {
      if (args.action === 'create') return { input: args, previous: null };
      const prior = await agents.privateMutationTarget(ctx.memberId, args.id, ctx.agent.id);
      return { input: args, previous: prior.manifest, previous_version: prior.row.currentVersion };
    },
    async execute(args, ctx) {
      const { action, ...values } = args;
      const saved =
        action === 'create'
          ? await agents.create(ctx.memberId, values)
          : await agents.update(ctx.memberId, (args as { id: string }).id, values);
      return { agent_id: saved.id, version: saved.current_version, name: saved.name, url: `#/agents/${saved.id}` };
    },
    async undo(_args, output, before, ctx) {
      const result = output as { agent_id: string; version: number };
      const prior = before as { previous: AgentManifest | null; previous_version?: number };
      const lineage = ctx.undoRevisions?.get(result.agent_id);
      const version = lineage?.written === result.version ? lineage.current : result.version;
      await agents.undoPrivateMutation(ctx.memberId, result.agent_id, version, prior.previous, ctx.agent.id);
      if (prior.previous_version !== undefined)
        ctx.undoRevisions?.set(result.agent_id, {
          written: prior.previous_version,
          current: (await agents.get(ctx.memberId, result.agent_id)).current_version,
        });
    },
    summarize: (args, out, locale) => {
      const name = (out as { name?: string } | undefined)?.name ?? args.name;
      const verb =
        args.action === 'create' ? (locale === 'zh' ? '新建了' : 'Created') : locale === 'zh' ? '修改了' : 'Updated';
      return locale === 'zh' ? `${verb} Agent${name ? `「${name}」` : ''}` : `${verb} Agent${name ? ` “${name}”` : ''}`;
    },
  });
}
