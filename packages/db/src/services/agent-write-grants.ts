/**
 * Agent write grants — standing approvals a member gives their own external
 * agents for r2 (shared-data) writes (PostgreSQL).
 *
 * The service only stores and matches grants. Which writes may be covered (r2
 * only, never r3) is enforced by the caller in apps/api/src/agent-access and
 * again here at creation, so a bad caller cannot store a grant for something
 * that must always be approved by hand.
 */

import { and, asc, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { agentWriteGrants, platformOAuthClients } from '../schema/index.js';
import type { AgentWriteGrantRow } from '../schema/agent-write-grant.js';

export const AGENT_WRITE_GRANT_DAYS = [1, 7, 30, 90] as const;
export type AgentWriteGrantDays = (typeof AGENT_WRITE_GRANT_DAYS)[number];

export interface AgentWriteGrantCreateInput {
  user_id: string;
  /** null = any OAuth client bound to this member. */
  client_id: string | null;
  tool_id: string;
  /** null = every r2 action of the tool. */
  action: string | null;
  days: AgentWriteGrantDays;
  created_via: AgentWriteGrantRow['created_via'];
}

export interface AgentWriteGrantView extends AgentWriteGrantRow {
  client_name: string | null;
}

export function createAgentWriteGrantService(db: Db) {
  return {
    async create(input: AgentWriteGrantCreateInput): Promise<AgentWriteGrantRow> {
      if (!(AGENT_WRITE_GRANT_DAYS as readonly number[]).includes(input.days)) {
        throw new Error(`days must be one of ${AGENT_WRITE_GRANT_DAYS.join(', ')}`);
      }
      const now = new Date();
      const [row] = await db
        .insert(agentWriteGrants)
        .values({
          id: `awg_${randomUUID().replaceAll('-', '')}`,
          user_id: input.user_id,
          client_id: input.client_id,
          tool_id: input.tool_id,
          action: input.action,
          created_via: input.created_via,
          expires_at: new Date(now.getTime() + input.days * 86_400_000).toISOString(),
          created_at: now.toISOString(),
        })
        .returning();
      return row!;
    },

    /**
     * The live grant that covers this write, if any: same member, the same
     * client or a client-agnostic grant, the same tool, the same action or an
     * action-agnostic grant. A specific grant wins over a broad one so its use
     * count tells the member which grant actually did the work.
     */
    async findCovering(input: {
      user_id: string;
      client_id: string | null;
      tool_id: string;
      action: string | null;
    }): Promise<AgentWriteGrantRow | undefined> {
      const rows = await db
        .select()
        .from(agentWriteGrants)
        .where(
          and(
            eq(agentWriteGrants.user_id, input.user_id),
            eq(agentWriteGrants.tool_id, input.tool_id),
            isNull(agentWriteGrants.revoked_at),
            gt(agentWriteGrants.expires_at, nowIso()),
            input.client_id
              ? or(isNull(agentWriteGrants.client_id), eq(agentWriteGrants.client_id, input.client_id))
              : isNull(agentWriteGrants.client_id),
            input.action
              ? or(isNull(agentWriteGrants.action), eq(agentWriteGrants.action, input.action))
              : isNull(agentWriteGrants.action),
          ),
        )
        .orderBy(desc(agentWriteGrants.created_at));
      const rank = (row: AgentWriteGrantRow) => (row.client_id ? 2 : 0) + (row.action ? 1 : 0);
      return rows.sort((a, b) => rank(b) - rank(a))[0];
    },

    async recordUse(id: string): Promise<void> {
      await db
        .update(agentWriteGrants)
        .set({ use_count: sql`${agentWriteGrants.use_count} + 1`, last_used_at: nowIso() })
        .where(eq(agentWriteGrants.id, id));
    },

    /** Live grants first (soonest expiry first), then the 50 most recent ended ones. */
    async listForUser(userId: string): Promise<AgentWriteGrantView[]> {
      const rows = await db
        .select({ grant: agentWriteGrants, client_name: platformOAuthClients.client_name })
        .from(agentWriteGrants)
        .leftJoin(platformOAuthClients, eq(platformOAuthClients.id, agentWriteGrants.client_id))
        .where(eq(agentWriteGrants.user_id, userId))
        .orderBy(asc(agentWriteGrants.expires_at));
      const now = Date.now();
      const views = rows.map((row) => ({ ...row.grant, client_name: row.client_name }));
      const live = views.filter((g) => !g.revoked_at && Date.parse(g.expires_at) > now);
      const ended = views
        .filter((g) => g.revoked_at || Date.parse(g.expires_at) <= now)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 50);
      return [...live, ...ended];
    },

    /** Revoke one of the member's own grants. Returns false when it is not theirs or already ended. */
    async revoke(userId: string, id: string): Promise<boolean> {
      const rows = await db
        .update(agentWriteGrants)
        .set({ revoked_at: nowIso() })
        .where(
          and(eq(agentWriteGrants.id, id), eq(agentWriteGrants.user_id, userId), isNull(agentWriteGrants.revoked_at)),
        )
        .returning({ id: agentWriteGrants.id });
      return rows.length > 0;
    },
  };
}

export type AgentWriteGrantService = ReturnType<typeof createAgentWriteGrantService>;
