/**
 * Agent transport — runtime event protocol (web side).
 *
 * The cloud streaming path folds NDJSON events into this `RuntimeEvent` union,
 * which the chat UI renders via `applyRuntimeEvent`.
 */

/** A single tool call as surfaced to the streaming UI (matches StreamingToolCall). */
export interface RuntimeToolCall {
  id: string;
  name: string;
  input: string;
  output?: unknown;
  status: 'calling' | 'done';
}

/** ask_user form schema (mirrors the cloud ask_user tool + AskUserCard). */
export interface RuntimeAskUserOption {
  value: string;
  label: string;
}
export interface RuntimeAskUserQuestion {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'single_choice' | 'multi_choice';
  options?: RuntimeAskUserOption[];
  required?: boolean;
  placeholder?: string;
}

/** Backend-agnostic agent events. Produced by cloud (NDJSON) or desktop Pi (sidecar). */
export type RuntimeEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call-start'; toolCallId: string; toolName: string; args?: unknown }
  | { type: 'tool-call-delta'; toolCallId: string; toolName: string; partial: unknown }
  | { type: 'tool-result'; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: 'local-permission-request'; toolCallId: string; toolName: string; action: string; detail: string }
  | {
      type: 'local-ask-user-request';
      requestId: string;
      title: string;
      description?: string;
      questions: RuntimeAskUserQuestion[];
    }
  | { type: 'session-state'; state: string; detail?: Record<string, unknown> }
  | { type: 'finish' }
  | { type: 'error'; message: string };

/** Aggregated streaming state the chat UI renders. Built by `applyRuntimeEvent`. */
export interface RuntimeStreamState {
  text: string;
  reasoning: string;
  toolCalls: RuntimeToolCall[];
  error: string | null;
  finished: boolean;
  /** Pending local action awaiting user approval (Ask mode), if any. */
  permissionRequest: { toolCallId: string; toolName: string; action: string; detail: string } | null;
}

/** Config to start a desktop Pi session (mirrors the sidecar's ServeStartConfig + workspace inputs). */
export interface PiStartConfig {
  permissionMode: 'explore' | 'ask' | 'execute';
  /** Owning user's email — Rust derives the per-session workspace path from it. */
  userEmail?: string;
  /** Client-generated session id — one workspace dir per session. */
  sessionId?: string;
  /** Explicit working dir override (else Rust computes from userEmail/sessionId). */
  cwd?: string;
  modelProvider?: string;
  modelId?: string;
  modelName?: string;
  modelBaseUrl?: string;
  modelMessageFormat?: 'openai_chat_completions' | 'anthropic_messages';
  /** Desktop BYOK model-provider config id used to resolve the encrypted API key. */
  modelConfigId?: string;
  cloud?: { baseUrl: string; apiKey: string; profileId?: string; workspaceId?: string };
  /** Condensed conversation history for session resumption (injected as Pi custom message). */
  historyContext?: string;
  /** Page context hint (same as Cloud Agent's context_hint). */
  contextHint?: string;
  /**
   * Desktop-only: MCP source slugs to activate for this session. Captured at
   * session start (tools bind once). Undefined ⇒ all enabled (legacy); an empty
   * array ⇒ none (the chat selector is opt-in).
   */
  mcpSourceSlugs?: string[];
}

/** A runtime that streams `RuntimeEvent`s, regardless of cloud/desktop backend. */
export interface AgentTransport {
  start(onEvent: (event: RuntimeEvent) => void): Promise<void>;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
  /** Resolve a pending Ask-mode permission request (desktop only). */
  respondPermission?(toolCallId: string, approved: boolean): Promise<void>;
  /** Resolve a pending ask_user request with the user's formatted answers (desktop only). */
  respondAskUser?(requestId: string, answers: string): Promise<void>;
}

/** Initial empty stream state. */
export function emptyStreamState(): RuntimeStreamState {
  return { text: '', reasoning: '', toolCalls: [], error: null, finished: false, permissionRequest: null };
}
