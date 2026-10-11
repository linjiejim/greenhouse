/**
 * `tables_schema_plan`, the Bots face — a Bot proposing a change to Tables
 * (structure, views, forms, automations, dashboards, roles, access, apps).
 *
 * The chat tool drafts a card the user confirms in the same turn; a Bot's
 * member may be away, so here the drafted plan becomes a durable `tables_plan`
 * request (spec 20261011-tables-apps §7, the `self` proposal pattern): valid
 * for 7 days, applied only when the member presses Apply, as the member,
 * through the same path a confirmed chat plan takes (`engine/requests.ts`). The
 * Bot hears the outcome when they decide. Nothing changes before that, so a
 * tainted turn may propose too — the proposal has no effect of its own.
 *
 * The draft check is the chat tool's (`draftTablesSchemaPlan`): every problem
 * goes back to the model before any card exists. The card is self-contained
 * (`BotTablesPlanPayload`): its lines and permission section are written here,
 * in the member's language, because the mobile app cannot word a plan itself.
 */

import { tool } from 'ai';
import type { BotTablesPlanPayload } from '@greenhouse/types/bots';
import type { SchemaPlanOperation } from '@greenhouse/types/tables';
import { toErrorMessage } from '@greenhouse/utils/error';
import { planAccessLines, planLines } from '../../platform/tables/schema-plan-words.js';
import {
  draftTablesSchemaPlan,
  schemaPlanSchema,
  TABLES_SCHEMA_PLAN_DESCRIPTION,
  type SchemaPlanInput,
} from '../../tools/tables-schema-plan.js';
import type { BotTurnContext } from '../engine/context.js';

/** A plan waits a week, like an instructions proposal: a durable suggestion, not an in-flight step. */
export const TABLES_PLAN_PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const BOTS_FACE = `

In this conversation the plan becomes a card the member applies when they choose (it waits up to 7 days); every step then runs as them. The call returns {status:"proposed", request_id}: say in one line what you proposed and stop — you are told the outcome, with the ids of what was created, when they decide.`;

/** The one existing Base a plan changes, when exactly one is named (the card links to it). */
function existingBaseId(operations: readonly SchemaPlanOperation[]): number | undefined {
  const ids = new Set<number>();
  for (const operation of operations) {
    if ('baseId' in operation && typeof operation.baseId === 'number') ids.add(operation.baseId);
  }
  return ids.size === 1 ? [...ids][0] : undefined;
}

export function createBotTablesPlanTool(ctx: BotTurnContext) {
  return tool({
    description: `${TABLES_SCHEMA_PLAN_DESCRIPTION}${BOTS_FACE}`,
    inputSchema: schemaPlanSchema,
    execute: async (input: SchemaPlanInput) => {
      try {
        const drafted = await draftTablesSchemaPlan(ctx.userId, input);
        if (!drafted.ok) return { error: drafted.error, problems: drafted.problems };
        const { artifact } = drafted;
        const baseId = existingBaseId(artifact.operations);
        const payload: BotTablesPlanPayload = {
          summary: artifact.summary,
          lines: planLines(artifact.operations, artifact.targetNames, ctx.locale),
          access: planAccessLines(artifact.accessChanges ?? [], ctx.locale),
          operations: artifact.operations,
          ...(baseId === undefined ? {} : { base_id: baseId }),
        };
        const request = await ctx.createRequest('tables_plan', payload, { expiresInMs: TABLES_PLAN_PROPOSAL_TTL_MS });
        return {
          status: 'proposed',
          request_id: request.id,
          note: 'The member now sees a card with every change and who gains access. Nothing exists until they apply it — say in one line what you proposed, then stop.',
        };
      } catch (error) {
        return { error: toErrorMessage(error) };
      }
    },
  });
}
