/**
 * Bounded MCP replies — oversized tool output is parked, not pasted.
 *
 * An MCP `tools/call` reply lands verbatim in the calling agent's context. A
 * knowledge export or a wide table page can be hundreds of kilobytes, which
 * floods that context and crowds out everything the agent was doing. So a
 * reply whose text exceeds MCP_REPLY_MAX_CHARS is stored whole as a private,
 * expiring object, and the agent gets a preview plus a handle it can page
 * through with the protocol-level `tool_output_read` tool.
 *
 * Storage: the existing object store (`storage/uploads.ts`, COS or local disk),
 * no table. The key is derived from the output id AND a hash of the member +
 * OAuth client that produced it, so a read rebuilds the key from the CALLER's
 * identity: another member or another client simply addresses a different key
 * and gets "not found" — there is no row to authorize against and nothing to
 * leak. `chat_files` was the first choice but every row must belong to a chat
 * session, and an MCP call has none. The id carries its creation time, so
 * expiry is checked on read (even before the sweep runs) and the sweep needs
 * nothing but a listing.
 *
 * The stored object also names the tool that produced the output, and a read
 * asks the caller's CURRENT permissions whether that tool is still allowed: a
 * permission narrowed after the call takes effect on the next read, not after
 * the 24 hours run out.
 *
 * Lengths are JavaScript string lengths (UTF-16 code units); ranges never split
 * a surrogate pair.
 */

import { createHash, randomUUID } from 'node:crypto';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import {
  deleteObjectAtKey,
  getObjectAtKey,
  listObjectKeys,
  putObjectAtKey,
  toolOutputKeyPrefix,
} from '../storage/uploads.js';

/** A reply longer than this is stored and previewed instead of returned. */
export const MCP_REPLY_MAX_CHARS = 12_000;
/** Preview length; leaves room for the handle so the whole reply stays under the cap. */
export const TOOL_OUTPUT_PREVIEW_CHARS = 8_000;
/** Largest range one `tool_output_read` call returns. */
export const TOOL_OUTPUT_READ_MAX_CHARS = 12_000;
/** Stored outputs expire a day after they were produced. */
export const TOOL_OUTPUT_TTL_MS = 24 * 60 * 60 * 1000;
/** Beyond this the stored copy is cut too (a runaway tool must not fill the bucket). */
export const TOOL_OUTPUT_MAX_STORED_CHARS = 4_000_000;

export const TOOL_OUTPUT_READ_TOOL = 'tool_output_read';

const OUTPUT_ID_PATTERN = /^out_(\d{13})_([0-9a-f]{32})$/;

export interface ToolOutputCaller {
  userId: string;
  clientId: string;
}

export interface McpTextContent {
  type: 'text';
  text: string;
}

/** Owner scope inside the key: who produced it, through which client. Not reversible. */
function ownerScope(caller: ToolOutputCaller): string {
  return createHash('sha256').update(`${caller.userId}\n${caller.clientId}`).digest('hex').slice(0, 40);
}

function keyFor(caller: ToolOutputCaller, outputId: string): string {
  return `${toolOutputKeyPrefix()}${ownerScope(caller)}/${outputId}.json`;
}

function createdAtOf(outputId: string): number | null {
  const match = OUTPUT_ID_PATTERN.exec(outputId);
  return match ? Number(match[1]) : null;
}

/** Never start a slice on the second half of a surrogate pair: step back to the whole character. */
function safeStart(text: string, start: number): number {
  if (start <= 0 || start >= text.length) return Math.max(0, Math.min(start, text.length));
  const code = text.charCodeAt(start);
  const before = text.charCodeAt(start - 1);
  return code >= 0xdc00 && code <= 0xdfff && before >= 0xd800 && before <= 0xdbff ? start - 1 : start;
}

/** What is stored: the output text plus the tool that produced it. */
interface StoredOutput {
  v: 1;
  source_tool: string;
  text: string;
}

/** Never end a slice between the two halves of a surrogate pair. */
function safeEnd(text: string, end: number): number {
  if (end <= 0 || end >= text.length) return Math.max(0, Math.min(end, text.length));
  const code = text.charCodeAt(end - 1);
  return code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

/**
 * Where the preview stops: the last line break, else the end of a JSON object or
 * array element (`},` / `],`), else the last comma or space — whichever falls in
 * the last quarter of the window. Only when none does is it a hard cut.
 */
export function previewBoundary(text: string, max: number): number {
  if (text.length <= max) return text.length;
  const window = text.slice(0, max);
  const floor = Math.floor(max * 0.75);
  const candidates = [
    window.lastIndexOf('\n') + 1,
    Math.max(window.lastIndexOf('},'), window.lastIndexOf('],')) + 2,
    window.lastIndexOf(',') + 1,
    window.lastIndexOf(' ') + 1,
  ];
  for (const cut of candidates) if (cut > floor) return safeEnd(text, cut);
  return safeEnd(text, max);
}

/**
 * Bound one reply text. Short text passes through untouched. Long text is stored
 * and replaced by two blocks: the handle first (so the agent sees `truncated`
 * before the content) and then the preview.
 */
export async function boundReplyText(
  text: string,
  caller: ToolOutputCaller,
  sourceTool: string,
  now: number = Date.now(),
): Promise<{ content: McpTextContent[]; outputId: string | null }> {
  if (text.length <= MCP_REPLY_MAX_CHARS) return { content: [{ type: 'text', text }], outputId: null };

  const previewEnd = previewBoundary(text, TOOL_OUTPUT_PREVIEW_CHARS);
  const stored =
    text.length > TOOL_OUTPUT_MAX_STORED_CHARS ? text.slice(0, safeEnd(text, TOOL_OUTPUT_MAX_STORED_CHARS)) : text;
  const outputId = `out_${now}_${randomUUID().replaceAll('-', '')}`;
  let savedId: string | null = outputId;
  try {
    const body: StoredOutput = { v: 1, source_tool: sourceTool, text: stored };
    await putObjectAtKey(keyFor(caller, outputId), Buffer.from(JSON.stringify(body), 'utf8'), 'application/json');
  } catch (error) {
    // The call itself succeeded (a write may already have run): still answer,
    // just without a handle, rather than failing or flooding.
    logger.warn('[mcp] could not store an oversized tool reply', { error: toErrorMessage(error) });
    savedId = null;
  }

  const handle = savedId
    ? {
        truncated: true,
        output_id: savedId,
        total_chars: text.length,
        ...(stored.length < text.length ? { stored_chars: stored.length } : {}),
        preview_chars: previewEnd,
        next_offset: previewEnd,
        expires_at: new Date(now + TOOL_OUTPUT_TTL_MS).toISOString(),
        note:
          `The result is too long to return in one reply; the block below is its first ${previewEnd} characters. ` +
          `Call ${TOOL_OUTPUT_READ_TOOL} with this output_id and offset=next_offset (limit up to ${TOOL_OUTPUT_READ_MAX_CHARS}) ` +
          'to read more, only as far as you need.',
      }
    : {
        truncated: true,
        output_id: null,
        total_chars: text.length,
        preview_chars: previewEnd,
        note: 'The result is too long to return and could not be stored for paging; narrow the request.',
      };
  return {
    content: [
      { type: 'text', text: JSON.stringify(handle) },
      { type: 'text', text: text.slice(0, previewEnd) },
    ],
    outputId: savedId,
  };
}

export class ToolOutputNotFoundError extends Error {
  constructor() {
    super('Output not found or expired. Outputs are kept for 24 hours and only for the client that produced them.');
    this.name = 'ToolOutputNotFoundError';
  }
}

export interface ToolOutputRange {
  output_id: string;
  offset: number;
  returned_chars: number;
  total_chars: number;
  next_offset: number | null;
  expires_at: string;
  text: string;
}

function parseStored(buffer: Buffer): StoredOutput | null {
  try {
    const parsed = JSON.parse(buffer.toString('utf8')) as Partial<StoredOutput>;
    return parsed && parsed.v === 1 && typeof parsed.source_tool === 'string' && typeof parsed.text === 'string'
      ? (parsed as StoredOutput)
      : null;
  } catch {
    return null;
  }
}

/**
 * Read `[offset, offset + limit)` of a stored output, for its producer only, and
 * only while `canUseTool` still allows the tool that produced it.
 */
export async function readToolOutput(
  caller: ToolOutputCaller,
  input: { outputId: string; offset?: number; limit?: number },
  canUseTool: (toolId: string) => boolean,
  now: number = Date.now(),
): Promise<ToolOutputRange> {
  const createdAt = createdAtOf(input.outputId);
  if (createdAt === null || now - createdAt > TOOL_OUTPUT_TTL_MS) throw new ToolOutputNotFoundError();
  const object = await getObjectAtKey(keyFor(caller, input.outputId));
  const stored = object ? parseStored(object.buffer) : null;
  // A revoked tool reads exactly like a missing output: nothing about it leaks.
  if (!stored || !canUseTool(stored.source_tool)) throw new ToolOutputNotFoundError();
  const text = stored.text;

  const offset = safeStart(text, Math.max(0, Math.min(Math.floor(input.offset ?? 0), text.length)));
  const limit = Math.max(
    1,
    Math.min(Math.floor(input.limit ?? TOOL_OUTPUT_READ_MAX_CHARS), TOOL_OUTPUT_READ_MAX_CHARS),
  );
  let end = safeEnd(text, offset + limit);
  // A one-unit range that starts on a high surrogate would otherwise be empty.
  if (end === offset && offset < text.length) end = Math.min(text.length, offset + 2);
  return {
    output_id: input.outputId,
    offset,
    returned_chars: end - offset,
    total_chars: text.length,
    next_offset: end < text.length ? end : null,
    expires_at: new Date(createdAt + TOOL_OUTPUT_TTL_MS).toISOString(),
    text: text.slice(offset, end),
  };
}

/** Delete every stored output older than the TTL. Returns how many were removed. */
export async function sweepExpiredToolOutputs(now: number = Date.now()): Promise<number> {
  let removed = 0;
  for (const key of await listObjectKeys(toolOutputKeyPrefix())) {
    const id = key.slice(key.lastIndexOf('/') + 1).replace(/\.json$/, '');
    const createdAt = createdAtOf(id);
    // Anything under the prefix that is not ours by shape is left alone.
    if (createdAt === null || now - createdAt <= TOOL_OUTPUT_TTL_MS) continue;
    await deleteObjectAtKey(key);
    removed += 1;
  }
  return removed;
}

/** MCP tool definition — protocol level, like agent_write_status; not a catalog tool. */
export function toolOutputReadToolDef() {
  return {
    name: TOOL_OUTPUT_READ_TOOL,
    description:
      'Read more of a tool result that was too long to return at once (the reply said truncated:true and gave an ' +
      `output_id). Returns up to ${TOOL_OUTPUT_READ_MAX_CHARS} characters from offset; continue from next_offset ` +
      'until it is null, but stop as soon as you have what you need. Outputs last 24 hours.',
    inputSchema: {
      type: 'object',
      properties: {
        output_id: { type: 'string', description: 'The output_id from a truncated result.' },
        offset: { type: 'integer', minimum: 0, default: 0 },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: TOOL_OUTPUT_READ_MAX_CHARS,
          default: TOOL_OUTPUT_READ_MAX_CHARS,
        },
      },
      required: ['output_id'],
      additionalProperties: false,
    },
  };
}
