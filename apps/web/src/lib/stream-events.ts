/**
 * Typed streaming event definitions for NDJSON chat streams.
 *
 * Re-exports from shared types — canonical definitions live in types/api.ts so
 * the browser stream consumer and API contract cannot drift.
 */

export type {
  TextDeltaEvent,
  ReasoningDeltaEvent,
  ToolCallStartEvent,
  ToolCallDeltaEvent,
  ToolCallEndEvent,
  ToolCallEvent,
  ToolResultEvent,
  SessionEvent,
  FinishEvent,
  ErrorEvent,
  StepStartEvent,
  StepFinishEvent,
  SourceEvent,
  TitleEvent,
  LocalToolRequestEvent,
  StreamingEvent,
  StreamEventCallbacks,
} from '@greenhouse/types/api';

export { handleStreamEvent } from '@greenhouse/types/api';

/** Tool-call state assembled by SessionManager for streaming UI components. */
export interface StreamingToolCall {
  id: string;
  name: string;
  input: string;
  output?: unknown;
  status: 'calling' | 'done';
}
