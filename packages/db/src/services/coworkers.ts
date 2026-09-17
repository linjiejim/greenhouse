import { randomUUID } from 'node:crypto';
import { and, eq, asc, isNull, lt } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import type { Db } from '../client.js';
import { createCoworkerInboxService } from './coworker-inbox.js';
import {
  coworkers,
  coworkerDialogues,
  coworkerRounds,
  sessions,
  coworkerWorkspaces,
  agentWorkspaces,
} from '../schema/index.js';

export function createCoworkerService(db: Db) {
  const service = {
    ...createCoworkerInboxService(db),
    async ensure(input: { profile_key: string; owner_user_id: string; name: string }) {
      const [row] = await db
        .insert(coworkers)
        .values({ id: randomUUID(), ...input, created_at: nowIso() })
        .onConflictDoUpdate({ target: [coworkers.owner_user_id, coworkers.profile_key], set: { name: input.name } })
        .returning();
      return row!;
    },
    async ensureWorkspace(agentId: string, userId: string, name: string) {
      return db.transaction(async (tx) => {
        const [agent] = await tx.select().from(coworkers).where(eq(coworkers.id, agentId)).for('update');
        if (!agent) throw new Error('Coworker not found');
        const [binding] = await tx
          .select()
          .from(coworkerWorkspaces)
          .where(and(eq(coworkerWorkspaces.agent_instance_id, agentId), eq(coworkerWorkspaces.user_id, userId)));
        if (binding) return binding.workspace_id;
        const now = nowIso();
        const [workspace] = await tx
          .insert(agentWorkspaces)
          .values({ user_id: userId, name, last_used_at: now, created_at: now, updated_at: now })
          .returning();
        await tx
          .insert(coworkerWorkspaces)
          .values({ agent_instance_id: agentId, user_id: userId, workspace_id: workspace!.id });
        return workspace!.id;
      });
    },
    async bindSession(sessionId: string, agentId: string) {
      await db
        .update(sessions)
        .set({ agent_instance_id: agentId })
        .where(and(eq(sessions.id, sessionId), isNull(sessions.agent_instance_id)));
    },
    async memoryScopeForSession(sessionId?: string | null) {
      const id = await service.scopeForSession(sessionId);
      if (!id) return null;
      const agent = await service.get(id);
      // Preserve existing Sprouty memories on upgrade; custom coworkers get their own scope.
      return agent?.profile_key === 'sprouty' ? null : id;
    },
    async get(id: string) {
      return (await db.select().from(coworkers).where(eq(coworkers.id, id)))[0];
    },
    async scopeForSession(sessionId?: string | null): Promise<string | null> {
      if (!sessionId) return null;
      const [session] = await db
        .select({ agentId: sessions.agent_instance_id })
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      return session?.agentId ?? null;
    },
    async createDialogue(input: typeof coworkerDialogues.$inferInsert) {
      const [row] = await db.insert(coworkerDialogues).values(input).onConflictDoNothing().returning();
      return row ?? (await db.select().from(coworkerDialogues).where(eq(coworkerDialogues.id, input.id)))[0]!;
    },
    async getDialogue(id: string, userId: string, originSessionId: string) {
      return (
        await db
          .select()
          .from(coworkerDialogues)
          .where(
            and(
              eq(coworkerDialogues.id, id),
              eq(coworkerDialogues.user_id, userId),
              eq(coworkerDialogues.origin_session_id, originSessionId),
            ),
          )
      )[0];
    },
    async rounds(dialogueId: string) {
      await db
        .update(coworkerRounds)
        .set({ status: 'failed', error: 'Discussion interrupted; this round was not replayed.' })
        .where(
          and(
            eq(coworkerRounds.dialogue_id, dialogueId),
            eq(coworkerRounds.status, 'running'),
            lt(coworkerRounds.created_at, new Date(Date.now() - 11 * 60_000).toISOString()),
          ),
        );
      return db
        .select()
        .from(coworkerRounds)
        .where(eq(coworkerRounds.dialogue_id, dialogueId))
        .orderBy(asc(coworkerRounds.round));
    },
    /** Lock the dialogue so parallel tool calls cannot exceed the cap or interleave rounds. */
    async admitRound(input: {
      id: string;
      dialogue_id: string;
      message: string;
      user_id: string;
      origin_session_id: string;
    }) {
      return db.transaction(async (tx) => {
        const [dialogue] = await tx
          .select()
          .from(coworkerDialogues)
          .where(
            and(
              eq(coworkerDialogues.id, input.dialogue_id),
              eq(coworkerDialogues.user_id, input.user_id),
              eq(coworkerDialogues.origin_session_id, input.origin_session_id),
            ),
          )
          .for('update');
        if (!dialogue) throw new Error('Conversation not found');
        const rows = await tx
          .select()
          .from(coworkerRounds)
          .where(eq(coworkerRounds.dialogue_id, dialogue.id))
          .orderBy(asc(coworkerRounds.round));
        const existing = rows.find((r) => r.id === input.id);
        if (existing) {
          if (existing.message !== input.message) throw new Error('Round identity already used');
          return { row: existing, admitted: false, history: rows };
        }
        if (rows.some((r) => r.status === 'running')) throw new Error('A colleague is still replying');
        if (rows.length >= 6) throw new Error('Six-round limit reached; summarize the discussion for the user');
        const [row] = await tx
          .insert(coworkerRounds)
          .values({
            id: input.id,
            dialogue_id: dialogue.id,
            round: rows.length + 1,
            message: input.message,
            created_at: nowIso(),
          })
          .returning();
        return { row: row!, admitted: true, history: rows };
      });
    },
    async finishRound(id: string, result: { reply?: string; error?: string; child_session_id?: string }) {
      await db
        .update(coworkerRounds)
        .set({
          reply: result.reply ?? null,
          error: result.error ?? null,
          child_session_id: result.child_session_id ?? null,
          status: result.error ? 'failed' : 'succeeded',
        })
        .where(and(eq(coworkerRounds.id, id), eq(coworkerRounds.status, 'running')));
    },
  };
  return service;
}
