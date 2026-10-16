/**
 * Folds a turn's stream parts into what the host persists and shows: the answer text, the
 * reasoning, and one record per tool call with its input, output and timing.
 */

import { toErrorMessage } from '@greenhouse/utils/error';

export interface ToolCallRecord {
  id: string;
  tool: string;
  input: unknown;
  output?: unknown;
  error?: string;
  status: 'running' | 'done' | 'failed';
  startedAt: number;
  durationMs?: number;
}

export interface LoopCollector {
  text: string;
  reasoning: string;
  calls: ToolCallRecord[];
  finished: boolean;
  aborted: boolean;
  error?: string;
}

export function createCollector(): LoopCollector {
  return { text: '', reasoning: '', calls: [], finished: false, aborted: false };
}

/** Applies one part; returns the tool call it started or settled, if any. */
export function collect(part: any, collector: LoopCollector, now = Date.now()): ToolCallRecord | undefined {
  switch (part.type) {
    case 'text-delta':
      collector.text += part.text ?? '';
      return undefined;
    case 'reasoning-delta':
      collector.reasoning += part.text ?? '';
      return undefined;
    case 'tool-call': {
      const record: ToolCallRecord = {
        id: part.toolCallId,
        tool: part.toolName,
        input: part.input,
        status: 'running',
        startedAt: now,
      };
      collector.calls.push(record);
      return record;
    }
    case 'tool-result':
    case 'tool-error': {
      const record = [...collector.calls]
        .reverse()
        .find((call) => call.id === part.toolCallId && call.status === 'running');
      if (!record) return undefined;
      record.durationMs = now - record.startedAt;
      if (part.type === 'tool-result') {
        record.status = 'done';
        record.output = part.output;
      } else {
        record.status = 'failed';
        record.error = toErrorMessage(part.error);
      }
      return record;
    }
    case 'finish':
      collector.finished = true;
      return undefined;
    case 'abort':
      collector.aborted = true;
      return undefined;
    case 'error':
      collector.error = toErrorMessage(part.error);
      return undefined;
    default:
      return undefined;
  }
}
