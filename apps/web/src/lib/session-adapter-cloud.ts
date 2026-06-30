/**
 * CloudSessionAdapter — wraps the existing HTTP API for cloud session CRUD.
 */

import * as api from './api';
import type {
  SessionAdapter,
  SessionItem,
  SessionDetail,
  MessageItem,
  CreateSessionInput,
  AppendMessageInput,
} from './session-adapter';

function mapSession(s: api.Session): SessionItem {
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    profileId: s.profile_id,
    channel: s.channel ?? 'web',
    createdAt: s.created_at ?? '',
    updatedAt: s.updated_at ?? '',
  };
}

function mapMessage(m: api.Message): MessageItem {
  return {
    id: m.id,
    sessionId: m.session_id,
    role: m.role,
    content: m.content,
    references: typeof m.references_ === 'string' ? m.references_ : JSON.stringify(m.references_ ?? []),
    pipeline: typeof m.pipeline === 'string' ? m.pipeline : JSON.stringify(m.pipeline ?? []),
    reasoning: m.reasoning ?? null,
    images: typeof m.images === 'string' ? m.images : JSON.stringify(m.images ?? []),
    confidence: m.confidence ?? null,
    grounded: m.grounded ?? null,
    inputTokens: m.input_tokens ?? null,
    outputTokens: m.output_tokens ?? null,
    cachedTokens: m.cached_tokens ?? null,
    reasoningTokens: m.reasoning_tokens ?? null,
    durationMs: m.duration_ms ?? null,
    createdAt: m.created_at,
  };
}

export class CloudSessionAdapter implements SessionAdapter {
  async list(opts?: { status?: string; limit?: number }): Promise<SessionItem[]> {
    const sessions = await api.listSessions(opts?.status);
    return sessions.slice(0, opts?.limit).map(mapSession);
  }

  async get(id: string): Promise<SessionDetail> {
    const data = await api.getSession(id);
    return {
      session: mapSession(data.session),
      messages: data.messages.map(mapMessage),
    };
  }

  async create(input: CreateSessionInput): Promise<SessionItem> {
    const session = await api.createSession(input.title, input.profileId);
    return mapSession(session);
  }

  async appendMessage(_sessionId: string, _msg: AppendMessageInput): Promise<void> {
    // Cloud sessions: messages are appended server-side during streaming.
    // No client-side append needed — this is a no-op.
  }

  async update(id: string, patch: { title?: string | null; status?: string }): Promise<void> {
    await api.updateSession(id, patch);
  }

  async delete(id: string): Promise<void> {
    await api.deleteSession(id);
  }
}
