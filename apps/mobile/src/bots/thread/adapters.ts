/**
 * Bots rows → the chat's message model, so the thread reuses the conversation's
 * renderers (`UserMessage` / `AiMessage`: markdown, tool rows and their live
 * sheets, artifacts, ask_user forms, menus) instead of growing its own:
 *
 *  - `fromBotMessage` — a persisted row (a member message, a Bot reply, a
 *    task report's body);
 *  - `fromPending` — a send this device has in flight;
 *  - `fromSegment` — one Bot's live turn: no words or tools yet → `thinking`
 *    (also what a segment behind the reveal front shows), words or tools →
 *    `streaming`, ended → `done` (`stopped` / `error` carried over).
 *
 * Every adapter caches by the *input object*: the rows are memoised on the
 * message they get, and the engine shares structure (an untouched message,
 * pending send or segment keeps its identity across stream ticks), so only
 * the row whose source changed re-renders. Pure (tested in ./adapters.test.ts).
 */

import { assistantFromParts, isErrorResult, webFromResult, type ChatMessage, type ToolStep } from '../../chat/model';
import type { BotMessage } from '../../shared/bots';
import type { BotStreamSegment, StreamingToolCall } from '../../shared/bots-wire';
import type { PendingSend } from '../vendor/transcript';

const messages = new WeakMap<BotMessage, ChatMessage>();
const pendings = new WeakMap<PendingSend, ChatMessage>();
const segments = new WeakMap<BotStreamSegment, { id: string; errorText: string; msg: ChatMessage }>();

/** A persisted row. Anything but a member message renders as a Bot's reply. */
export function fromBotMessage(message: BotMessage): ChatMessage {
  const cached = messages.get(message);
  if (cached) return cached;
  const msg: ChatMessage =
    message.role === 'user'
      ? {
          id: message.id,
          serverId: message.id,
          role: 'user',
          text: message.content,
          wire: message.content,
          images: message.images,
          status: 'done',
        }
      : assistantFromParts({
          id: message.id,
          content: message.content,
          pipeline: message.pipeline,
          references: message.references,
          reasoning: message.reasoning,
        });
  messages.set(message, msg);
  return msg;
}

/** A send in flight (its bubble animates in — it was just written). */
export function fromPending(pending: PendingSend): ChatMessage {
  const cached = pendings.get(pending);
  if (cached) return cached;
  const msg: ChatMessage = {
    id: `pending:${pending.clientId}`,
    role: 'user',
    text: pending.content,
    wire: pending.content,
    images: pending.images,
    status: 'done',
    fresh: true,
  };
  pendings.set(pending, msg);
  return msg;
}

function toolStep(call: StreamingToolCall): ToolStep {
  return {
    id: call.id,
    tool: call.name,
    // Streamed input is (possibly partial) JSON text; the tools sheet pretty-prints it.
    input: call.input,
    output: call.output,
    status: call.status === 'calling' ? 'running' : isErrorResult(call.output) ? 'error' : 'done',
  };
}

/**
 * A live segment as a reply. `id` must be unique across runs (the tools /
 * reasoning sheets follow a turn by id — live-turn.ts); `errorText` is what a
 * failed turn says when the server gave no reason.
 */
export function fromSegment(segment: BotStreamSegment, opts: { id: string; errorText: string }): ChatMessage {
  const cached = segments.get(segment);
  if (cached && cached.id === opts.id && cached.errorText === opts.errorText) return cached.msg;
  const tools = segment.toolCalls.map(toolStep);
  const web = tools.flatMap((step) => (step.status === 'running' ? [] : webFromResult(step.tool, step.output)));
  const live = segment.status === 'streaming';
  const msg: ChatMessage = {
    id: opts.id,
    role: 'assistant',
    text: segment.text,
    tools: tools.length ? tools : undefined,
    reasoning: segment.reasoning || undefined,
    web: web.length ? web : undefined,
    status: live ? (segment.text || tools.length ? 'streaming' : 'thinking') : 'done',
    stopped: segment.status === 'stopped' || undefined,
    error: segment.status === 'error' ? segment.error || opts.errorText : undefined,
    fresh: true,
  };
  segments.set(segment, { id: opts.id, errorText: opts.errorText, msg });
  return msg;
}
