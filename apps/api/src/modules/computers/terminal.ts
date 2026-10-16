/**
 * The member's terminal: `gh-term` in the computer (apps/bot-computer), a tmux session as the
 * `agent` user that outlives the socket, so a page reload comes back to the same shell.
 *
 * Socket: a binary message is keystrokes, a text message is `{"type":"resize","cols","rows"}`;
 * the terminal's output comes back raw, binary. Towards gh-term every message becomes one frame
 * on its stdin: type u8, payload length u32 big-endian, payload; type 0 is bytes for the
 * terminal, type 1 the resize JSON `{"cols","rows"}`, clamped as gh-term clamps it.
 */

import { terminalResizeSchema } from '@greenhouse/contract';
import { AGENT_HOME } from './files.js';

export const TERMINAL_ARGV = ['gh-term'];
/** The home, not ~/work: gh-term makes ~/work itself and starts the shell there, even after it was deleted. */
export const TERMINAL_CWD = AGENT_HOME;

export const TERMINAL_FRAME = { data: 0, resize: 1 } as const;
const COLS = { min: 10, max: 500 };
const ROWS = { min: 5, max: 200 };
/** A resize message is tiny; anything longer is not one. */
const MAX_CONTROL_CHARS = 256;

/** One gh-term frame. */
export function terminalFrame(type: number, payload: Uint8Array): Buffer {
  const frame = Buffer.allocUnsafe(5 + payload.length);
  frame.writeUInt8(type, 0);
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, 5);
  return frame;
}

const clamp = (value: number, range: { min: number; max: number }) => Math.min(Math.max(value, range.min), range.max);

/** A text message from the socket as gh-term's resize frame; null when it is not a resize. */
export function resizeFrame(text: string): Buffer | null {
  if (text.length > MAX_CONTROL_CHARS) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = terminalResizeSchema.safeParse(value);
  if (!parsed.success) return null;
  const size = { cols: clamp(parsed.data.cols, COLS), rows: clamp(parsed.data.rows, ROWS) };
  return terminalFrame(TERMINAL_FRAME.resize, Buffer.from(JSON.stringify(size)));
}
