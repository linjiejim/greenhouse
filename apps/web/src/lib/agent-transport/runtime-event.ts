/**
 * Pure reducer: fold a RuntimeEvent into the streaming UI state.
 *
 * Backend-agnostic and side-effect free, so it's unit-testable without a DOM and
 * reusable by any transport (cloud or desktop Pi).
 */

import type { RuntimeEvent, RuntimeStreamState, RuntimeToolCall } from './types';

function partialToString(partial: unknown): string {
  if (typeof partial === 'string') return partial;
  try {
    return JSON.stringify(partial);
  } catch {
    return String(partial);
  }
}

/** Return a new state with `event` applied. Never mutates `state`. */
export function applyRuntimeEvent(state: RuntimeStreamState, event: RuntimeEvent): RuntimeStreamState {
  switch (event.type) {
    case 'text-delta':
      return { ...state, text: state.text + event.text };

    case 'reasoning-delta':
      return { ...state, reasoning: state.reasoning + event.text };

    case 'tool-call-start': {
      const tc: RuntimeToolCall = {
        id: event.toolCallId,
        name: event.toolName,
        input: event.args !== undefined ? partialToString(event.args) : '',
        status: 'calling',
      };
      // De-dup by id (a start for a known id replaces it).
      const rest = state.toolCalls.filter((t) => t.id !== event.toolCallId);
      return { ...state, toolCalls: [...rest, tc] };
    }

    case 'tool-call-delta':
      return {
        ...state,
        toolCalls: state.toolCalls.map((t) =>
          t.id === event.toolCallId ? { ...t, input: t.input + partialToString(event.partial) } : t,
        ),
      };

    case 'tool-result':
      return {
        ...state,
        toolCalls: state.toolCalls.map((t) =>
          t.id === event.toolCallId ? { ...t, output: event.result, status: 'done' } : t,
        ),
      };

    case 'local-permission-request':
      return {
        ...state,
        permissionRequest: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          action: event.action,
          detail: event.detail,
        },
      };

    case 'error':
      return { ...state, error: event.message };

    case 'finish':
      return { ...state, finished: true };

    case 'session-state':
    default:
      return state;
  }
}
