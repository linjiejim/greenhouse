/**
 * Members' cloud computers — the server-side record of each hosted sandbox
 * (schema/member-computer.ts) and the only place its state changes.
 *
 * Every transition is a compare-and-set on the row (its status and, for
 * billing, its open block's reservation key), so two API processes — or the
 * idle sweeper racing a member's stop — can never both act on one computer.
 * Starting one is serialised workspace-wide under one advisory lock: the
 * concurrency limit is counted and the member's slot taken in the same
 * transaction.
 */

import { randomBytes } from 'node:crypto';
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { memberComputers } from '../schema/index.js';
import {
  ACTIVE_MEMBER_COMPUTER_STATUSES,
  type MemberComputerRow,
  type MemberComputerStatus,
} from '../schema/member-computer.js';

const START_LOCK = 'member-computers:start';

function newComputerId(): string {
  return `cmp_${randomBytes(8).toString('hex')}`;
}

export interface ClaimComputerInput {
  user_id: string;
  /** Running computers the workspace allows at once. */
  max_running: number;
  client: string;
  oauth_client_id?: string | null;
  at?: string;
}

export type ClaimComputerResult =
  | { status: 'claimed'; row: MemberComputerRow }
  | { status: 'exists'; row: MemberComputerRow }
  | { status: 'full'; running: number };

export interface FinishComputerInput {
  /** The status the caller saw; the change applies only if it still holds. */
  from: readonly MemberComputerStatus[];
  status: Extract<MemberComputerStatus, 'stopped' | 'failed' | 'lost'>;
  stop_reason: string;
  /** Minutes settled by this transition, added to `minutes_billed`. */
  add_minutes?: number;
  sandbox_id?: string | null;
  at?: string;
}

export function createMemberComputerService(db: Db) {
  const service = {
    /**
     * Take the member's slot: their active computer if they have one, else a
     * new `starting` row — unless the workspace already runs `max_running`.
     */
    async claimStart(input: ClaimComputerInput): Promise<ClaimComputerResult> {
      const at = input.at ?? nowIso();
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${START_LOCK}, 0))`);
        const [existing] = await tx
          .select()
          .from(memberComputers)
          .where(
            and(
              eq(memberComputers.user_id, input.user_id),
              inArray(memberComputers.status, [...ACTIVE_MEMBER_COMPUTER_STATUSES]),
            ),
          )
          .limit(1);
        if (existing) return { status: 'exists', row: existing };
        const [{ running }] = (await tx
          .select({ running: sql<number>`count(*)::int` })
          .from(memberComputers)
          .where(inArray(memberComputers.status, [...ACTIVE_MEMBER_COMPUTER_STATUSES]))) as [{ running: number }];
        if (running >= input.max_running) return { status: 'full', running };
        const [row] = await tx
          .insert(memberComputers)
          .values({
            id: newComputerId(),
            user_id: input.user_id,
            status: 'starting',
            started_at: at,
            last_used_at: at,
            client: input.client,
            oauth_client_id: input.oauth_client_id ?? null,
            created_at: at,
            updated_at: at,
          })
          .returning();
        return { status: 'claimed', row: row! };
      });
    },

    async get(id: string): Promise<MemberComputerRow | undefined> {
      const [row] = await db.select().from(memberComputers).where(eq(memberComputers.id, id)).limit(1);
      return row;
    },

    /** The member's computer that holds a slot, if any. */
    async getActiveForUser(userId: string): Promise<MemberComputerRow | undefined> {
      const [row] = await db
        .select()
        .from(memberComputers)
        .where(
          and(
            eq(memberComputers.user_id, userId),
            inArray(memberComputers.status, [...ACTIVE_MEMBER_COMPUTER_STATUSES]),
          ),
        )
        .limit(1);
      return row;
    },

    /** Every computer holding a slot, oldest first. */
    async listActive(): Promise<MemberComputerRow[]> {
      return db
        .select()
        .from(memberComputers)
        .where(inArray(memberComputers.status, [...ACTIVE_MEMBER_COMPUTER_STATUSES]))
        .orderBy(memberComputers.started_at);
    },

    /** The member's latest computers, newest first. */
    async listForUser(userId: string, limit = 10): Promise<MemberComputerRow[]> {
      return db
        .select()
        .from(memberComputers)
        .where(eq(memberComputers.user_id, userId))
        .orderBy(desc(memberComputers.started_at))
        .limit(Math.min(Math.max(limit, 1), 100));
    },

    /** Minutes settled on the member's computers started in [from, to). */
    async minutesForUser(userId: string, from: string, to: string): Promise<number> {
      const [row] = (await db
        .select({ minutes: sql<number>`coalesce(sum(${memberComputers.minutes_billed}), 0)::int` })
        .from(memberComputers)
        .where(
          and(
            eq(memberComputers.user_id, userId),
            gte(memberComputers.started_at, from),
            lt(memberComputers.started_at, to),
          ),
        )) as [{ minutes: number }];
      return row.minutes;
    },

    /** `starting` → `running` with its sandbox and first block's reservation. */
    async markRunning(
      id: string,
      input: { sandbox_id: string; budget_key: string | null; block_started_at: string; at?: string },
    ): Promise<MemberComputerRow | undefined> {
      const at = input.at ?? nowIso();
      const [row] = await db
        .update(memberComputers)
        .set({
          status: 'running',
          sandbox_id: input.sandbox_id,
          budget_key: input.budget_key,
          block_started_at: input.block_started_at,
          last_used_at: at,
          updated_at: at,
        })
        .where(and(eq(memberComputers.id, id), eq(memberComputers.status, 'starting')))
        .returning();
      return row;
    },

    /** Record use: the idle timer restarts from here. */
    async touch(id: string, at: string = nowIso()): Promise<void> {
      await db
        .update(memberComputers)
        .set({ last_used_at: at, updated_at: at })
        .where(and(eq(memberComputers.id, id), eq(memberComputers.status, 'running')));
    },

    /**
     * Close the open block and open the next — only if the block the caller
     * settled is still the open one (another process may have rolled it).
     */
    async rollBlock(
      id: string,
      input: {
        expected_budget_key: string | null;
        budget_key: string | null;
        block_started_at: string;
        add_minutes: number;
        at?: string;
      },
    ): Promise<MemberComputerRow | undefined> {
      const at = input.at ?? nowIso();
      const sameKey =
        input.expected_budget_key === null
          ? sql`${memberComputers.budget_key} IS NULL`
          : eq(memberComputers.budget_key, input.expected_budget_key);
      const [row] = await db
        .update(memberComputers)
        .set({
          budget_key: input.budget_key,
          block_started_at: input.block_started_at,
          minutes_billed: sql`${memberComputers.minutes_billed} + ${Math.max(0, Math.ceil(input.add_minutes))}`,
          updated_at: at,
        })
        .where(and(eq(memberComputers.id, id), eq(memberComputers.status, 'running'), sameKey))
        .returning();
      return row;
    },

    /** `running` → `stopping`: exactly one caller wins the right to stop it. */
    async claimStop(id: string, at: string = nowIso()): Promise<MemberComputerRow | undefined> {
      const [row] = await db
        .update(memberComputers)
        .set({ status: 'stopping', updated_at: at })
        .where(and(eq(memberComputers.id, id), eq(memberComputers.status, 'running')))
        .returning();
      return row;
    },

    /** End a computer: stopped (settled), failed (never ran) or lost (stop unconfirmed). */
    async finish(id: string, input: FinishComputerInput): Promise<MemberComputerRow | undefined> {
      const at = input.at ?? nowIso();
      const [row] = await db
        .update(memberComputers)
        .set({
          status: input.status,
          stop_reason: input.stop_reason,
          stopped_at: at,
          minutes_billed: sql`${memberComputers.minutes_billed} + ${Math.max(0, Math.ceil(input.add_minutes ?? 0))}`,
          ...(input.sandbox_id !== undefined ? { sandbox_id: input.sandbox_id } : {}),
          budget_key: null,
          updated_at: at,
        })
        .where(and(eq(memberComputers.id, id), inArray(memberComputers.status, [...input.from])))
        .returning();
      return row;
    },
  };
  return service;
}

export type MemberComputerService = ReturnType<typeof createMemberComputerService>;
