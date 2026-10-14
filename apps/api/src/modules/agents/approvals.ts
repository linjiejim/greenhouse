import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { approvalScopeSchema, type StandingApproval } from '@greenhouse/contract';
import { getDb, newId, standingApprovals, type NeedsYouRequest } from '@greenhouse/db';
import { conflict, notFound } from '../../http/errors.js';
import { decodeCursor, toPage } from '../../http/pagination.js';
import type { AgentsService } from './service.js';
import type { ApprovalScope } from '../../engine/tools/define.js';
import type { KnowledgeService } from '../knowledge/service.js';
import type { TablesService } from '../tables/service.js';

const view = (row: typeof standingApprovals.$inferSelect): StandingApproval => ({
  id: row.id,
  agent_id: row.agentId,
  scope_type: row.scopeType,
  scope_id: row.scopeId,
  actions: row.actions,
  granted_at: row.grantedAt,
  revoked_at: row.revokedAt,
});

export function createApprovalsService(agents: AgentsService, knowledge: KnowledgeService, tables: TablesService) {
  return {
    async allows(agentId: string, memberId: string, scope: ApprovalScope): Promise<boolean> {
      const [row] = await getDb()
        .select()
        .from(standingApprovals)
        .where(
          and(
            eq(standingApprovals.agentId, agentId),
            eq(standingApprovals.memberId, memberId),
            eq(standingApprovals.scopeType, scope.type),
            eq(standingApprovals.scopeId, scope.id),
            isNull(standingApprovals.revokedAt),
          ),
        )
        .for('share');
      return !!row && scope.actions.every((action) => row.actions.includes(action));
    },
    /** Called only inside the transaction settling this member's approval card. */
    async grant(request: NeedsYouRequest) {
      const parsed = approvalScopeSchema.safeParse(request.payload.standing_scope);
      if (request.subject !== 'tool_write' || request.payload.tier !== 'tier2' || !request.agentId || !parsed.success)
        throw conflict('standing_not_allowed', 'This card cannot grant a standing approval.');
      await agents.load(request.memberId, request.agentId);
      const scope = parsed.data;
      await getDb()
        .insert(standingApprovals)
        .values({
          id: newId('standingApproval'),
          agentId: request.agentId,
          memberId: request.memberId,
          scopeType: scope.type,
          scopeId: scope.id,
          actions: scope.actions,
        })
        .onConflictDoUpdate({
          target: [
            standingApprovals.agentId,
            standingApprovals.memberId,
            standingApprovals.scopeType,
            standingApprovals.scopeId,
          ],
          targetWhere: sql`${standingApprovals.revokedAt} IS NULL`,
          set: {
            actions: sql`(select jsonb_agg(distinct value) from jsonb_array_elements(${standingApprovals.actions} || ${JSON.stringify(scope.actions)}::jsonb) items(value))`,
          },
        });
    },
    async list(memberId: string, handle: string, query: { cursor?: string; limit: number }) {
      const { agent } = await agents.load(memberId, handle);
      const before = decodeCursor(query.cursor);
      const rows = await getDb()
        .select()
        .from(standingApprovals)
        .where(
          and(
            eq(standingApprovals.agentId, agent.id),
            eq(standingApprovals.memberId, memberId),
            isNull(standingApprovals.revokedAt),
            before ? lt(standingApprovals.id, before) : undefined,
          ),
        )
        .orderBy(desc(standingApprovals.id))
        .limit(query.limit + 1);
      const labels = new Map(
        await Promise.all(
          rows.map(async (row) => {
            const label = await (
              row.scopeType === 'folder'
                ? knowledge
                    .folder(memberId, row.scopeId)
                    .then((folder) => ({ name: folder.name, href: `#/knowledge/folder/${folder.id}` }))
                : tables.scopeLabel(memberId, row.scopeId)
            ).catch(() => null);
            return [row.id, label] as const;
          }),
        ),
      );
      return toPage(rows, query.limit, (row) => ({
        ...view(row),
        scope_name: labels.get(row.id)?.name ?? null,
        scope_href: labels.get(row.id)?.href ?? null,
      }));
    },
    async revoke(memberId: string, handle: string, id: string) {
      const { agent } = await agents.load(memberId, handle);
      const [row] = await getDb()
        .update(standingApprovals)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(standingApprovals.id, id),
            eq(standingApprovals.agentId, agent.id),
            eq(standingApprovals.memberId, memberId),
            isNull(standingApprovals.revokedAt),
          ),
        )
        .returning();
      if (!row) throw notFound('Standing approval');
    },
  };
}
export type ApprovalsService = ReturnType<typeof createApprovalsService>;
