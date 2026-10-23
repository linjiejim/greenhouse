/**
 * WebSocket message protocol types — shared between API and Web.
 *
 * Server → Client: ServerWsEvent (discriminated union on `type`)
 * Client → Server: ClientWsEvent (discriminated union on `type`)
 */

import type { ChatRunStatus } from './api.js';

// ─── Online User ─────────────────────────────────────────

export interface OnlineUser {
  userId: string;
  nickname: string;
  role: string;
  connectedAt: string; // ISO 8601
}

// ─── Server → Client Events ─────────────────────────────

export type KnowledgeDocChangeKind = 'created' | 'updated' | 'archived';

export type ServerWsEvent =
  | { type: 'connected'; userId: string }
  | { type: 'ping' }
  | { type: 'share:count'; count: number }
  | { type: 'notification:summary'; unread: number }
  | {
      type: 'notification:new';
      notificationId: string;
      kind: string;
      title: string;
      unread: number;
      runId?: string | null;
      interruptId?: string | null;
    }
  | {
      type: 'share:new';
      shareId: number;
      sessionId: string;
      sessionTitle: string;
      sharedBy: string;
      sharedByNickname: string;
      message?: string;
    }
  | { type: 'presence:snapshot'; users: OnlineUser[] }
  | { type: 'presence:join'; user: OnlineUser }
  | { type: 'presence:leave'; userId: string }
  // Chat generation lifecycle: a turn started/ended for one of the owner's
  // sessions. Carries no content — clients attach to the run's NDJSON stream
  // (GET /api/chat/runs/:sessionId/stream) or refetch messages on end.
  | {
      type: 'chat:run';
      sessionId: string;
      runId: string;
      status: ChatRunStatus;
    }
  // A knowledge document the recipient can see was created, edited or archived
  // (web, chat tool, MCP or an approved agent write). Ids only: clients refetch
  // over the authenticated API.
  | { type: 'knowledge.changed'; docId: number; change: KnowledgeDocChangeKind }
  // Cross-domain Execution Center invalidation. Payload contents stay on the
  // authenticated Runtime API; WS carries only identity and sequence.
  | {
      type: 'runtime:invalidate';
      runId: string;
      kind: string;
      eventType: string;
      seq: number;
    };

// ─── Client → Server Events ─────────────────────────────

export type ClientWsEvent = { type: 'pong' };
