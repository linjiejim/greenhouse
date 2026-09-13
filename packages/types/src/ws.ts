/**
 * WebSocket message protocol types — shared between API and Web.
 *
 * Server → Client: ServerWsEvent (discriminated union on `type`)
 * Client → Server: ClientWsEvent (discriminated union on `type`)
 */

import type { ChatRunStatus } from './api.js';
import type { AgentRunStatus } from './cloud-agent.js';

// ─── Online User ─────────────────────────────────────────

export interface OnlineUser {
  userId: string;
  nickname: string;
  role: string;
  connectedAt: string; // ISO 8601
}

// ─── Server → Client Events ─────────────────────────────

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
  // A session was created server-side for this user (e.g. spawn_session) so the
  // client can refresh its history list without a manual reload.
  | { type: 'session:created'; sessionId: string; parentSessionId: string; title: string }
  // Workflow engine progress: run/node status transitions, pushed to the owner
  // so the run card updates without polling.
  | {
      type: 'workflow:progress';
      runId: string;
      runStatus: string;
      nodeId?: string;
      nodeStatus?: string;
    }
  // Chat generation lifecycle: a turn started/ended for one of the owner's
  // sessions. Carries no content — clients attach to the run's NDJSON stream
  // (GET /api/chat/runs/:sessionId/stream) or refetch messages on end.
  | {
      type: 'chat:run';
      sessionId: string;
      runId: string;
      status: ChatRunStatus;
    }
  // Cloud Agent mission lifecycle: a sandbox run of the owner's changed state.
  // Third sibling of chat:run / workflow:progress and deliberately the same
  // shape — id + status only. Content stays on the run's event replay
  // (GET /api/missions/runs/:id/events?after=); pushing it here would be a
  // second, competing delivery path (session-modes spec D7).
  | {
      type: 'mission:run';
      runId: string;
      /** The conversation the run speaks through, when it has one. */
      sessionId?: string | null;
      status: AgentRunStatus;
    }
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
