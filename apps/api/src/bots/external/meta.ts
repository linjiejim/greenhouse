/**
 * Agent access tool catalog entries — metadata only (spec 20261011-agent-first-class P6, D48).
 *
 * The member's Agents from outside Greenhouse: an MCP client (Claude Code, a machine client), the
 * CLI. They are built per request only on those surfaces (`LazyServerToolContext.externalCaller`),
 * carry `context: 'external'` so GET /api/tools and the Agent editor leave them out, and ride the
 * `bots` feature point. Chat, an Agent's own turns, scheduled runs and Feishu never build them.
 *
 * A zero-import leaf (types only), so feature-points.ts and the registry can import it without a
 * cycle. Descriptions reach the calling model: keep them tight.
 */

import type { ToolMeta } from '../../tools/define.js';

const base = {
  category: 'core',
  is_global: false,
  context: 'external',
} as const satisfies Partial<ToolMeta>;

export const AGENT_ACCESS_TOOL_METAS: readonly ToolMeta[] = [
  {
    ...base,
    id: 'agents_list',
    name: 'List Agents',
    brief: "List the Greenhouse Agents you can talk to: your own and the public ones you're offered",
    icon: 'Bot',
    surface: { proxy: 'read', mcp: 'agents' },
    sort_order: 120,
    description: `List this account's main Agent, own Agents and public Agents offered to it (with owner names). Use their IDs with agent_message.`,
  },
  {
    ...base,
    id: 'agent_message',
    name: 'Message an Agent',
    brief: 'Send a message to one of your Greenhouse Agents and get its reply',
    icon: 'Send',
    surface: { proxy: 'write', mcp: 'agents' },
    sort_order: 121,
    description: `Message a Greenhouse Agent; a new conversation appears in the member's app unless you continue one.
Write a self-contained message: the Agent sees only that conversation.
answered: replies ready; working: poll agent_conversation_get later; needs_you: the member must approve or sign in at the returned app URL. You cannot do that for them.`,
  },
  {
    ...base,
    id: 'agent_conversation_get',
    name: 'Read an Agent conversation',
    brief: 'Read the latest replies in a conversation with one of your Greenhouse Agents',
    icon: 'MessagesSquare',
    surface: { proxy: 'read', mcp: 'agents' },
    sort_order: 122,
    description: `Read replies in a conversation started by agent_message (by default, since the last message sent to it). Poll while status is working.`,
  },
];

export const AGENT_ACCESS_TOOL_IDS: readonly string[] = AGENT_ACCESS_TOOL_METAS.map((m) => m.id);
