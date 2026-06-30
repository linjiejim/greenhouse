/**
 * WebSocket message protocol types — shared between API and Web.
 *
 * Server → Client: ServerWsEvent (discriminated union on `type`)
 * Client → Server: ClientWsEvent (discriminated union on `type`)
 */

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
  | { type: 'session:created'; sessionId: string; parentSessionId: string; title: string };

// ─── Client → Server Events ─────────────────────────────

export type ClientWsEvent = { type: 'pong' };
