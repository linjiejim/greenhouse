/**
 * `browser` — the Bot's own tab in the member's computer browser.
 *
 * A thin AI SDK wrapper: the schema the model sees, and the turn → session
 * plumbing. Everything that matters (leases, take-over, masking, hints, human
 * checks) lives in computer/browser-session.ts. Background turns get the
 * read-only subset.
 */

import { tool, type Tool } from 'ai';
import { z } from 'zod';
import {
  BACKGROUND_BROWSER_ACTIONS,
  BROWSER_ACTIONS,
  BrowserSession,
  defaultComputerDeps,
  WAIT_MAX_S,
  type ComputerDeps,
  type ComputerTurn,
} from '../computer/browser-session.js';
import { BOT_TOOL_METAS } from './meta.js';

const meta = BOT_TOOL_METAS.find((m) => m.id === 'browser')!;

const fields = {
  url: z.string().max(2000).optional().describe('open: the address (https:// assumed).'),
  ref: z
    .string()
    .max(24)
    .optional()
    .describe('click/type/select/hover/drag/upload, or scroll to: an element ref from the latest snapshot, e.g. e12.'),
  to_ref: z.string().max(24).optional().describe('drag: the ref of the element to drop onto.'),
  text: z.string().max(5000).optional().describe('type: replaces the field content. wait: text to wait for.'),
  submit: z.boolean().optional().describe('type: press Enter afterwards.'),
  value: z.string().max(500).optional().describe('select: option text or value.'),
  key: z.string().max(40).optional().describe('press: Enter, Tab, Escape, ArrowDown, PageDown, Control+A…'),
  direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('scroll: default down.'),
  tab: z.number().int().min(1).max(10).optional().describe('tabs: switch to this tab number.'),
  path: z.string().max(1000).optional().describe('upload: a file on the computer, relative to ~/work or ~/… (≤20 MB).'),
  timeout_s: z
    .number()
    .int()
    .min(1)
    .max(WAIT_MAX_S)
    .optional()
    .describe(`wait: seconds (default 10 with text, else 3; at most ${WAIT_MAX_S}).`),
  from_line: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'snapshot: show the page from this line on — a long page is cut, and its marker says which line to ask for.',
    ),
};

const foregroundSchema = z.object({ action: z.enum(BROWSER_ACTIONS), ...fields });

const backgroundSchema = z.object({
  action: z.enum(BACKGROUND_BROWSER_ACTIONS),
  url: fields.url,
  ref: z.string().max(24).optional().describe('scroll to: an element ref from the latest snapshot.'),
  text: z.string().max(5000).optional().describe('wait: text to wait for.'),
  direction: fields.direction,
  tab: fields.tab,
  timeout_s: fields.timeout_s,
  from_line: fields.from_line,
});

export function createBrowserTool(turn: ComputerTurn, deps: ComputerDeps = defaultComputerDeps): Tool {
  if (turn.background) {
    return tool({
      description: `${meta.description}\nIn this background task only open, snapshot, scroll, wait, back, tabs and screenshot work (read-only, signed out).`,
      inputSchema: backgroundSchema,
      execute: (input) => new BrowserSession(turn, deps).run(input),
    });
  }
  return tool({
    description: meta.description,
    inputSchema: foregroundSchema,
    execute: (input) => new BrowserSession(turn, deps).run(input),
  });
}
