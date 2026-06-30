/**
 * SessionAdapter — unified interface for session CRUD across cloud and local storage.
 *
 * Cloud sessions live in Postgres (accessed via HTTP API); local sessions use JSONL
 * files on disk (accessed via Desktop IPC). This adapter lets UI components work with
 * both without knowing the storage backend.
 */

export interface SessionItem {
  id: string;
  title: string | null;
  status: string;
  profileId: string;
  channel: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageItem {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  references: string;
  pipeline: string;
  reasoning: string | null;
  images: string;
  confidence: number | null;
  grounded: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  durationMs: number | null;
  createdAt: string;
}

export interface SessionDetail {
  session: SessionItem;
  messages: MessageItem[];
}

export interface CreateSessionInput {
  profileId: string;
  title?: string;
  userEmail?: string;
  modelProvider?: string;
  modelId?: string;
}

export interface AppendMessageInput {
  role: string;
  content: string;
  references?: string;
  pipeline?: string;
  reasoning?: string | null;
  images?: string;
  confidence?: number | null;
  grounded?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
  durationMs?: number | null;
  seq?: number;
}

export interface SessionAdapter {
  list(opts?: { status?: string; limit?: number }): Promise<SessionItem[]>;
  get(id: string): Promise<SessionDetail>;
  create(input: CreateSessionInput): Promise<SessionItem>;
  appendMessage(sessionId: string, msg: AppendMessageInput): Promise<void>;
  update(id: string, patch: { title?: string | null; status?: string }): Promise<void>;
  delete(id: string): Promise<void>;
}
