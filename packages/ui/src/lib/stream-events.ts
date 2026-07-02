/**
 * Typed streaming event definitions for NDJSON chat streams.
 *
 * Re-exports from shared types — canonical definitions live in types/api.ts
 * so they can be reused by React Native and other clients.
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
