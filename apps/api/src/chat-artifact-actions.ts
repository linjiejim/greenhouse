/**
 * Shared durable-claim boundary for non-idempotent actions launched from Chat.
 */

import { createHash } from 'node:crypto';
import { getDb, type ChatArtifactKind, type ChatArtifactReceiptRow } from '@greenhouse/db';
import { safeJsonParse } from '@greenhouse/utils/json';
import type { AuthUser } from './auth/token.js';
import { canWriteSession } from './session-access.js';

export type ArtifactActionClaim =
  | { ok: true; claimed: true; receipt: ChatArtifactReceiptRow }
  | { ok: true; claimed: false; receipt: ChatArtifactReceiptRow }
  | { ok: false; status: 400 | 404 | 409; error: string };

export function artifactRequestHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export async function claimArtifactAction(input: {
  actionId: string;
  sessionId: string;
  user: AuthUser;
  kind: ChatArtifactKind;
  payload: unknown;
}): Promise<ArtifactActionClaim> {
  // Shape: `artifact:<messageId>:<index>:<toolName>`. The message-id segment may
  // itself contain colons — runtime-traced turns persist assistant messages as
  // `chat-runtime-result:<runId>:<status>` (chat-runtime.ts) — so it is matched
  // greedily and only bounded in length; the id is an opaque claim key, never parsed.
  if (!/^artifact:.{1,160}:\d+:[a-z0-9_-]+$/.test(input.actionId)) {
    return { ok: false, status: 400, error: 'Invalid artifact action id' };
  }

  const session = await getDb().sessions.getById(input.sessionId);
  if (!session || !canWriteSession(input.user, session)) {
    return { ok: false, status: 404, error: 'Session not found' };
  }

  const requestHash = artifactRequestHash(input.payload);
  let claim;
  try {
    claim = await getDb().chatArtifactReceipts.claim({
      id: input.actionId,
      session_id: input.sessionId,
      user_id: input.user.id,
      kind: input.kind,
      request_hash: requestHash,
    });
  } catch {
    return { ok: false, status: 409, error: 'Artifact action id is already in use' };
  }

  if (
    claim.receipt.session_id !== input.sessionId ||
    claim.receipt.kind !== input.kind ||
    claim.receipt.request_hash !== requestHash
  ) {
    return { ok: false, status: 409, error: 'Artifact action payload does not match its original receipt' };
  }
  return { ok: true, claimed: claim.claimed, receipt: claim.receipt };
}

export function artifactReceiptResult<T>(receipt: ChatArtifactReceiptRow): T | undefined {
  if (receipt.status !== 'succeeded') return undefined;
  return safeJsonParse(receipt.result, undefined) as T | undefined;
}

export function publicArtifactReceipt(receipt: ChatArtifactReceiptRow) {
  return {
    id: receipt.id,
    kind: receipt.kind,
    status: receipt.status,
    result: safeJsonParse(receipt.result, {}),
    error: receipt.error,
    updated_at: receipt.updated_at,
  };
}
