import { assertDiscriminator } from '@greenhouse/types/discriminators';
/**
 * Durable receipts for non-idempotent actions launched from Chat cards
 * (`card_action_receipts`). The id is the card action's client-chosen key.
 */

import { and, eq } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { cardActionReceipts as chatArtifactReceipts } from '../schema/index.js';
import type { ChatArtifactReceiptRow } from '../schema/conversations.js';

export type ChatArtifactKind = ChatArtifactReceiptRow['kind'];

export interface ClaimChatArtifactInput {
  id: string;
  session_id: string;
  user_id: string;
  kind: ChatArtifactKind;
  request_hash: string;
}

export type ChatArtifactClaim =
  | { claimed: true; receipt: ChatArtifactReceiptRow }
  | { claimed: false; receipt: ChatArtifactReceiptRow };

export function createChatArtifactReceiptService(db: Db) {
  return {
    async claim(input: ClaimChatArtifactInput): Promise<ChatArtifactClaim> {
      assertDiscriminator('artifactKinds', input.kind);
      const now = nowIso();
      const [inserted] = await db
        .insert(chatArtifactReceipts)
        .values({
          ...input,
          status: 'processing',
          result: {},
          error: null,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoNothing({ target: chatArtifactReceipts.id })
        .returning();
      if (inserted) return { claimed: true, receipt: inserted };

      const [existing] = await db
        .select()
        .from(chatArtifactReceipts)
        .where(and(eq(chatArtifactReceipts.id, input.id), eq(chatArtifactReceipts.user_id, input.user_id)))
        .limit(1);
      if (!existing) throw new Error('Artifact action id is already owned by another user');
      return { claimed: false, receipt: existing };
    },

    async getForUser(id: string, userId: string): Promise<ChatArtifactReceiptRow | undefined> {
      const [row] = await db
        .select()
        .from(chatArtifactReceipts)
        .where(and(eq(chatArtifactReceipts.id, id), eq(chatArtifactReceipts.user_id, userId)))
        .limit(1);
      return row;
    },

    async succeed(id: string, userId: string, result: unknown): Promise<ChatArtifactReceiptRow | undefined> {
      const [row] = await db
        .update(chatArtifactReceipts)
        .set({
          status: 'succeeded',
          result: (result ?? {}) as Record<string, unknown>,
          error: null,
          updated_at: nowIso(),
        })
        .where(and(eq(chatArtifactReceipts.id, id), eq(chatArtifactReceipts.user_id, userId)))
        .returning();
      return row;
    },

    async fail(id: string, userId: string, error: string): Promise<ChatArtifactReceiptRow | undefined> {
      const [row] = await db
        .update(chatArtifactReceipts)
        .set({ status: 'failed', error, updated_at: nowIso() })
        .where(and(eq(chatArtifactReceipts.id, id), eq(chatArtifactReceipts.user_id, userId)))
        .returning();
      return row;
    },
  };
}

export type ChatArtifactReceiptService = ReturnType<typeof createChatArtifactReceiptService>;
