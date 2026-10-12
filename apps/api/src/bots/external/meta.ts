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
    description: `List the Greenhouse Agents this account can talk to: kind "main" (the member's main Agent), "own" (their other Agents) and "public" (other members' Agents published to them, with the owner's name). Use an id with agent_message.`,
  },
  {
    ...base,
    id: 'agent_message',
    name: 'Message an Agent',
    brief: 'Send a message to one of your Greenhouse Agents and get its reply',
    icon: 'Send',
    surface: { proxy: 'write', mcp: 'agents' },
    sort_order: 121,
    description: `Send a message to a Greenhouse Agent and wait for its reply.
agent_id: from agents_list (omit for the main Agent). Without conversation_id a new conversation starts (it shows in the member's Greenhouse app); pass the returned conversation_id to continue it.
Waits up to wait_seconds (default 45, max 55). status: answered — replies are in; working — still busy: call agent_conversation_get with the conversation_id later; needs_you — the Agent is waiting for the member to approve or sign in inside the Greenhouse app (url): you cannot do that for them.
Write a self-contained message: the Agent sees only this conversation.`,
  },
  {
    ...base,
    id: 'agent_conversation_get',
    name: 'Read an Agent conversation',
    brief: 'Read the latest replies in a conversation with one of your Greenhouse Agents',
    icon: 'MessagesSquare',
    surface: { proxy: 'read', mcp: 'agents' },
    sort_order: 122,
    description: `Read a conversation with a Greenhouse Agent that agent_message started: its status (answered / working / needs_you) and the replies after the last message sent to it, or after after_message_id. Poll it while the status is working.`,
  },
];

export const AGENT_ACCESS_TOOL_IDS: readonly string[] = AGENT_ACCESS_TOOL_METAS.map((m) => m.id);
