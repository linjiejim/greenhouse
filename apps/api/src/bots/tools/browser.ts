/**
 * `browser` — the Bot's own tab in the member's computer browser.
 *
 * A thin AI SDK wrapper: the schema the model sees, and the turn → session
 * plumbing. Everything that matters (leases, take-over, masking, hints) lives
 * in computer/browser-session.ts. Background turns get the read-only subset.
 */

import { tool, type Tool } from 'ai';
import { z } from 'zod';
import {
  BACKGROUND_BROWSER_ACTIONS,
  BROWSER_ACTIONS,
  BrowserSession,
  defaultComputerDeps,
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
    .describe('click/type/select, or scroll to: an element ref from the latest snapshot, e.g. e12.'),
  text: z.string().max(5000).optional().describe('type: replaces the field content.'),
  submit: z.boolean().optional().describe('type: press Enter afterwards.'),
  value: z.string().max(500).optional().describe('select: option text or value.'),
  key: z.string().max(40).optional().describe('press: Enter, Tab, Escape, ArrowDown, PageDown, Control+A…'),
  direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('scroll: default down.'),
  tab: z.number().int().min(1).max(10).optional().describe('tabs: switch to this tab number.'),
};

const foregroundSchema = z.object({ action: z.enum(BROWSER_ACTIONS), ...fields });

const backgroundSchema = z.object({
  action: z.enum(BACKGROUND_BROWSER_ACTIONS),
  url: fields.url,
  ref: z.string().max(24).optional().describe('scroll to: an element ref from the latest snapshot.'),
  direction: fields.direction,
  tab: fields.tab,
});

export function createBrowserTool(turn: ComputerTurn, deps: ComputerDeps = defaultComputerDeps): Tool {
  if (turn.background) {
    return tool({
      description: `${meta.description}\nIn this background task only open, snapshot, scroll, back, tabs and screenshot work (read-only, signed out).`,
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
