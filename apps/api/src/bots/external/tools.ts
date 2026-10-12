/**
 * The Agent access tools (spec 20261011-agent-first-class P6, D48): the member's Agents for an
 * MCP client or the CLI. Built per request with the caller in hand (`buildLazyServerTools` when
 * `externalCaller` is set) — nowhere else. The work is in ./agents.ts, loaded on first call: it
 * pulls in the Agents engine, which most proxy requests never need.
 */

import { tool, type Tool } from 'ai';
import { z } from 'zod';
import type { DatabaseProvider } from '@greenhouse/db';
import { AGENT_ACCESS_TOOL_METAS } from './meta.js';
import type { ExternalCaller } from './agents.js';

const DEFAULT_WAIT_SECONDS = 45;
const MAX_WAIT_SECONDS = 55;

const descriptionOf = (id: string) => AGENT_ACCESS_TOOL_METAS.find((meta) => meta.id === id)!.description;

const listSchema = z.object({});

const messageSchema = z.object({
  agent_id: z.string().max(64).optional().describe('From agents_list; omit for the main Agent.'),
  message: z.string().min(1).max(8000).describe('What to tell or ask the Agent — self-contained.'),
  conversation_id: z.string().max(64).optional().describe('Continue this conversation (from an earlier result).'),
  wait_seconds: z
    .number()
    .int()
    .min(0)
    .max(MAX_WAIT_SECONDS)
    .optional()
    .describe(`How long to wait for the reply (default ${DEFAULT_WAIT_SECONDS}).`),
});

const getSchema = z.object({
  conversation_id: z.string().max(64).describe('From agent_message.'),
  after_message_id: z.string().max(64).optional().describe('Only replies after this message.'),
});

export interface AgentAccessToolContext {
  db: DatabaseProvider;
  userId: string;
  caller: ExternalCaller;
}

async function guarded<T>(work: () => Promise<T>): Promise<T | { error: string; code: string }> {
  const { AgentAccessError } = await import('./agents.js');
  try {
    return await work();
  } catch (error) {
    if (error instanceof AgentAccessError) return { error: error.message, code: error.code };
    throw error;
  }
}

export function createAgentAccessTools(ctx: AgentAccessToolContext, toolIds: readonly string[]): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  if (toolIds.includes('agents_list')) {
    tools.agents_list = tool({
      description: descriptionOf('agents_list'),
      inputSchema: listSchema,
      execute: async () =>
        guarded(async () => {
          const { listReachableAgents } = await import('./agents.js');
          return { agents: await listReachableAgents(ctx.db, ctx.userId) };
        }),
    });
  }
  if (toolIds.includes('agent_message')) {
    tools.agent_message = tool({
      description: descriptionOf('agent_message'),
      inputSchema: messageSchema,
      execute: async (input: z.infer<typeof messageSchema>) =>
        guarded(async () => {
          const { askAgent } = await import('./agents.js');
          return askAgent({
            db: ctx.db,
            userId: ctx.userId,
            agentId: input.agent_id,
            conversationId: input.conversation_id,
            message: input.message,
            caller: ctx.caller,
            waitMs: (input.wait_seconds ?? DEFAULT_WAIT_SECONDS) * 1000,
          });
        }),
    });
  }
  if (toolIds.includes('agent_conversation_get')) {
    tools.agent_conversation_get = tool({
      description: descriptionOf('agent_conversation_get'),
      inputSchema: getSchema,
      execute: async (input: z.infer<typeof getSchema>) =>
        guarded(async () => {
          const { readAgentConversation } = await import('./agents.js');
          return readAgentConversation({
            db: ctx.db,
            userId: ctx.userId,
            conversationId: input.conversation_id,
            afterMessageId: input.after_message_id,
          });
        }),
    });
  }
  return tools;
}
