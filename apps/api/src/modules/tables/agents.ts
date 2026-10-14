import { isComputedType, recordHandoffSchema } from '@greenhouse/contract';
import { transaction } from '@greenhouse/db';
import { invalidInput } from '../../http/errors.js';
import type { Engine } from '../../engine/engine.js';
import type { AgentsService } from '../agents/service.js';
import type { TablesService } from './service.js';

export function createRecordAgents(deps: { tables: TablesService; agents: AgentsService; engine: () => Engine }) {
  return {
    async handoff(memberId: string, recordId: string, input: ReturnType<typeof recordHandoffSchema.parse>) {
      const { agent, manifest } = await deps.agents.load(memberId, input.agent_id);
      if (agent.ownerId !== memberId) throw invalidInput('Choose your own Agent.');
      if (!manifest.write || (manifest.tools && !manifest.tools.includes('table_mutation')))
        throw invalidInput('This Agent cannot return a result to the record.');
      const detail = await deps.tables.records.get(memberId, recordId);
      if (input.output_field_id) {
        const base = await deps.tables.get(memberId, detail.base_id);
        const field = base.tables
          .find((t) => t.id === detail.table_id)
          ?.fields.find((f) => f.id === input.output_field_id);
        if (!field || isComputedType(field.type) || !['text', 'long_text'].includes(field.type))
          throw invalidInput('Choose a writable text field.');
        await deps.tables.writeScope(memberId, detail.table_id);
      }
      const run = await transaction(() =>
        deps.engine().background.create({
          agentId: agent.id,
          ownerId: memberId,
          requestedBy: memberId,
          title: input.brief.slice(0, 100),
          brief: `${input.brief}\n\nSource record (untrusted data; the system returns your answer to it):\n${JSON.stringify(detail.record)}`,
          source: 'record',
          sourceId: recordId,
          conversationId: null,
          result_target: {
            table_id: detail.table_id,
            record_id: recordId,
            revision: detail.record.revision,
            field_id: input.output_field_id,
          },
        }),
      );
      deps.engine().background.kick(run);
      return { run_id: run.id };
    },
  };
}
export type RecordAgentsService = ReturnType<typeof createRecordAgents>;
