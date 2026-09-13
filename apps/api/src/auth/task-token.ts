/**
 * Cloud Agent task tokens — short-lived, run-bound sandbox credentials.
 *
 * Format: "lpct_<base64url(payload)>.<hmac_sha256>" with HMAC purpose
 * 'cloud-agent-task' (same TOKEN_SIGNING_KEY as access tokens; the purpose
 * separation makes the two families mutually unverifiable).
 *
 * A task token is the ONLY credential a sandbox holds besides its per-run
 * relay key. Exactly two surfaces accept it, and both re-read the bound user
 * and run from the database on every request (active internal account, run
 * ownership, run not yet terminal — so a finished run's token opens nothing):
 *
 *   • /api/missions/internal/* — the runner's event/artifact/completion push;
 *     /api/cloud-agent/internal/* remains a compatibility alias.
 *   • /api/agent/*                 — the sandbox's platform tool face
 *     (agent-runtime/api-auth.ts, 2026-07-31). The mission acts AS its owner:
 *     the same read tools plus confirm-gated writes, never more.
 *
 * It grants no access to /api/mcp or any user-facing surface.
 */

import { timingSafeEqual } from 'node:crypto';
import { hmacSign } from './token.js';

const PREFIX = 'lpct_';
const PURPOSE = 'cloud-agent-task';

/** Grace period past the run's wall-clock budget for final uploads. */
export const TASK_TOKEN_GRACE_MS = 10 * 60 * 1000;

export interface TaskTokenPayload {
  uid: string;
  runId: string;
  exp: number; // expiry timestamp (seconds)
}

/** Sign a task token for one run; TTL = wall budget + upload grace. */
export function createTaskToken(uid: string, runId: string, maxWallMs: number): string {
  const payload: TaskTokenPayload = {
    uid,
    runId,
    exp: Math.floor((Date.now() + maxWallMs + TASK_TOKEN_GRACE_MS) / 1000),
  };
  const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${PREFIX}${payloadStr}.${hmacSign(payloadStr, PURPOSE)}`;
}

/** Validate signature, shape and expiry. Returns null on any mismatch. */
export function validateTaskToken(token: string): TaskTokenPayload | null {
  if (!token.startsWith(PREFIX)) return null;
  const parts = token.slice(PREFIX.length).split('.');
  if (parts.length !== 2) return null;

  const [payloadStr, sig] = parts;
  if (!/^[0-9a-f]{64}$/i.test(sig)) return null;
  const expected = hmacSign(payloadStr, PURPOSE);
  if (!timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString()) as Partial<TaskTokenPayload>;
    if (typeof payload.uid !== 'string' || payload.uid.length === 0) return null;
    if (typeof payload.runId !== 'string' || payload.runId.length === 0) return null;
    if (typeof payload.exp !== 'number' || !Number.isInteger(payload.exp)) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload as TaskTokenPayload;
  } catch {
    return null;
  }
}
