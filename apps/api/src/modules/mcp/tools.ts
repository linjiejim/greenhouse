/**
 * The tools `/api/mcp` offers. Each one belongs to the scopes that open it and calls the same
 * service as the HTTP route, as the member the token acts for, so it can never see or do more
 * than that member can in the app. Writes the app would put behind an approval card stay there:
 * the Agent raises the card in the app and the tool reports `needs_you`.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { CONVERSATION_KINDS, type OAuthScope } from '@greenhouse/contract';
import { agents as agentsTable, getDb } from '@greenhouse/db';
import type { Engine } from '../../engine/engine.js';
import type { Hub } from '../../realtime/hub.js';
import { agentIdOf, type AgentsService } from '../agents/service.js';
import type { ConversationsService } from '../conversations/service.js';
import type { RunsService } from '../runs/service.js';
import type { SchedulesService } from '../schedules/service.js';
import type { SearchService } from '../search/service.js';
import type { Caller } from '../oauth/service.js';
import { ASK_MAX_CHARS, WAIT_MAX_SECONDS, createExchange, type ExchangeService } from './exchange.js';

export interface McpServices {
  agents: AgentsService;
  conversations: ConversationsService;
  engine: Engine;
  hub: Hub;
  runs: RunsService;
  schedules: SchedulesService;
  search: SearchService;
}

export interface McpToolContext {
  caller: Caller;
  services: McpServices;
  exchange: ExchangeService;
}

export interface McpTool<I = any> {
  name: string;
  /** The tool is listed when the token holds any of these. */
  scopes: readonly OAuthScope[];
  description: string;
  input: z.ZodType<I>;
  readOnly: boolean;
  run(input: I, ctx: McpToolContext): Promise<unknown>;
}

const defineMcpTool = <I>(tool: McpTool<I>): McpTool<I> => tool;

const TEXT_MAX = 20_000;
const cut = (text: string, max = TEXT_MAX) => (text.length > max ? `${text.slice(0, max)}\n…(cut)` : text);

/** Names of Agents as this member sees them: their own by name, public ones by their published face. */
async function agentNames(services: McpServices, memberId: string, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (!wanted.length) return new Map<string, string>();
  const own = await getDb()
    .select({ id: agentsTable.id, name: agentsTable.name })
    .from(agentsTable)
    .where(and(inArray(agentsTable.id, wanted), eq(agentsTable.ownerId, memberId)));
  const names = new Map(own.map((row) => [row.id, row.name]));
  const faces = await services.agents.publishedFaces(
    memberId,
    wanted.filter((id) => !names.has(id)),
  );
  for (const [id, face] of faces) names.set(id, face.name);
  return names;
}

const agentId = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .describe('An Agent id from agents_list, or "main" for your main Agent.');
const waitSeconds = z
  .number()
  .int()
  .min(0)
  .max(WAIT_MAX_SECONDS)
  .describe(`How long to wait for the answer, in seconds (at most ${WAIT_MAX_SECONDS}).`);

export const MCP_TOOLS: readonly McpTool[] = [
  defineMcpTool({
    name: 'agents_list',
    scopes: ['agents:read', 'agents:ask'],
    description:
      'List the Greenhouse Agents you can talk to: your main Agent (id "main" also works), your other Agents, and public Agents other members shared with you (with their owner).',
    input: z.object({}),
    readOnly: true,
    async run(_input, { caller, services }) {
      const [mine, shared] = await Promise.all([
        services.agents.list(caller.memberId, 'mine'),
        services.agents.listPublic(caller.memberId),
      ]);
      return {
        agents: [
          ...mine.map((agent) => ({
            id: agent.id,
            name: agent.name,
            role: agent.role,
            description: agent.description,
            kind: agent.is_main ? 'main' : 'own',
            owner: null,
          })),
          ...shared.map((agent) => ({
            id: agent.id,
            name: agent.name,
            role: agent.role,
            description: agent.description,
            kind: 'public',
            owner: agent.owner.name,
          })),
        ],
      };
    },
  }),

  defineMcpTool({
    name: 'agent_message',
    scopes: ['agents:ask'],
    description: `Send a message to a Greenhouse Agent in its thread (the one you see in the app) and wait for its reply.
Status: answered (the replies are in), working (still busy: call agent_conversation_get with the conversation_id later), needs_you (the Agent waits for the member to approve something or answer a question in the Greenhouse app, at url; you cannot do that for them).
The Agent sees its thread, not your context: write a self-contained message.`,
    input: z.object({
      agent_id: agentId.default('main'),
      message: z.string().min(1).max(ASK_MAX_CHARS),
      wait_seconds: waitSeconds.default(30),
    }),
    readOnly: false,
    run: (input, { caller, exchange }) =>
      exchange.ask(caller.memberId, { agent: input.agent_id, message: input.message, waitSeconds: input.wait_seconds }),
  }),

  defineMcpTool({
    name: 'agent_conversation_get',
    scopes: ['agents:ask'],
    description:
      'Read what happened in a Greenhouse Agent thread after a point (by default after your latest message there): its status (answered, working, needs_you) and the replies. Pass after_seq from earlier results to read on; wait_seconds waits while the Agent works.',
    input: z.object({
      conversation_id: z.string().min(1).max(64),
      after_seq: z.number().int().min(0).optional(),
      wait_seconds: waitSeconds.default(0),
    }),
    readOnly: true,
    run: (input, { caller, exchange }) =>
      exchange.read(caller.memberId, {
        conversationId: input.conversation_id,
        afterSeq: input.after_seq,
        waitSeconds: input.wait_seconds,
      }),
  }),

  defineMcpTool({
    name: 'conversations_list',
    scopes: ['conversations:read'],
    description:
      'List your Greenhouse conversations, most recent activity first: main (with your main Agent), direct (with another Agent), chat and room. Narrow by kind or by a word in the title; pass next_cursor to read on.',
    input: z.object({
      kind: z.enum(CONVERSATION_KINDS).optional(),
      title: z.string().trim().min(1).max(100).optional(),
      archived: z.boolean().default(false),
      cursor: z.string().max(400).optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    readOnly: true,
    async run(input, { caller, services }) {
      const page = await services.conversations.list(caller.memberId, {
        kind: input.kind,
        q: input.title,
        archived: input.archived ? 'true' : 'false',
        cursor: input.cursor,
        limit: input.limit,
      });
      const names = await agentNames(
        services,
        caller.memberId,
        page.items.map((item) => item.agent_id),
      );
      return {
        conversations: page.items.map((item) => ({
          id: item.id,
          kind: item.kind,
          title: item.title || names.get(item.agent_id ?? '') || '',
          agent_id: item.agent_id,
          unread: item.unread,
          working: item.working,
          needs_you: item.pending_requests,
          last_activity_at: item.last_activity_at,
        })),
        next_cursor: page.next_cursor,
      };
    },
  }),

  defineMcpTool({
    name: 'conversations_search',
    scopes: ['conversations:read'],
    description:
      'Search your Greenhouse conversations: titles, and the text of messages in conversations you are in. Returns where each match is (conversation_id, seq) with the text around it; read more with conversation_get.',
    input: z.object({
      query: z.string().trim().min(1).max(100),
      limit: z.number().int().min(1).max(20).default(10),
    }),
    readOnly: true,
    async run(input, { caller, services }) {
      const found = await services.search.search(caller.memberId, {
        q: input.query,
        kinds: ['conversations', 'messages'],
        limit: input.limit,
      });
      return {
        results: found.items.map((item) => ({
          kind: item.kind === 'messages' ? 'message' : 'conversation',
          conversation_id: item.conversation_id,
          title: item.title,
          ...(item.snippet ? { text: item.snippet } : {}),
          ...(item.seq !== undefined ? { seq: item.seq } : {}),
        })),
      };
    },
  }),

  defineMcpTool({
    name: 'conversation_get',
    scopes: ['conversations:read'],
    description:
      'Read messages of one of your Greenhouse conversations, oldest to newest: by default the latest ones. Pass next_cursor for older messages, or after_seq for the ones after a point.',
    input: z.object({
      conversation_id: z.string().min(1).max(64),
      cursor: z.string().max(400).optional(),
      after_seq: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(100).default(30),
    }),
    readOnly: true,
    async run(input, { caller, services }) {
      const conversation = await services.conversations.get(caller.memberId, input.conversation_id);
      const [page, people] = await Promise.all([
        services.conversations.messages(caller.memberId, input.conversation_id, {
          cursor: input.cursor,
          after: input.after_seq,
          limit: input.limit,
        }),
        services.conversations.people(caller.memberId, input.conversation_id),
      ]);
      const memberNames = new Map(people.members.map((person) => [person.id, person.name]));
      const agentNamesById = new Map(people.agents.map((agent) => [agent.id, agent.name]));
      const unknown = page.items.map((item) => item.agent_id).filter((id) => id && !agentNamesById.has(id));
      for (const [id, name] of await agentNames(services, caller.memberId, unknown)) agentNamesById.set(id, name);
      return {
        conversation: {
          id: conversation.id,
          kind: conversation.kind,
          title: conversation.title || agentNamesById.get(conversation.agent_id ?? '') || '',
          agent_id: conversation.agent_id,
          working: conversation.working,
          last_activity_at: conversation.last_activity_at,
        },
        messages: page.items.map((item) => ({
          seq: item.seq,
          role: item.role,
          author:
            item.role === 'user'
              ? (memberNames.get(item.author_member_id ?? '') ?? 'Someone')
              : (agentNamesById.get(item.agent_id ?? '') ?? (item.role === 'assistant' ? 'Agent' : '')),
          text: cut(item.content),
          ...(item.attachments.length ? { attachments: item.attachments.length } : {}),
          status: item.status,
          created_at: item.created_at,
        })),
        next_cursor: page.next_cursor,
      };
    },
  }),

  defineMcpTool({
    name: 'runs_list',
    scopes: ['runs:read'],
    description:
      'List your background runs in Greenhouse (work your Agents do on their own: from a conversation, a schedule, a hand-off), newest first. Narrow by state or Agent.',
    input: z.object({
      state: z.enum(['active', 'done', 'all']).default('all'),
      agent_id: agentId.optional(),
      cursor: z.string().max(400).optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    readOnly: true,
    async run(input, { caller, services }) {
      const agent =
        input.agent_id === 'main'
          ? (await services.agents.ensureMain(caller.memberId)).id
          : input.agent_id && agentIdOf(input.agent_id);
      const page = await services.runs.list(caller.memberId, {
        state: input.state,
        agent,
        cursor: input.cursor,
        limit: input.limit,
      });
      return { runs: page.items, next_cursor: page.next_cursor };
    },
  }),

  defineMcpTool({
    name: 'run_get',
    scopes: ['runs:read'],
    description:
      'Read one background run: its brief, its report when it finished, and the steps it took (tool, status, error).',
    input: z.object({ run_id: z.string().min(1).max(64) }),
    readOnly: true,
    async run(input, { caller, services }) {
      const { steps, events: _events, output, ...run } = await services.runs.get(caller.memberId, input.run_id);
      return {
        ...run,
        output: output === null ? null : cut(output),
        steps: steps.map((step) => ({
          tool: step.tool,
          kind: step.kind,
          status: step.status,
          error: step.error,
          duration_ms: step.duration_ms,
        })),
      };
    },
  }),

  defineMcpTool({
    name: 'schedules_list',
    scopes: ['runs:read'],
    description:
      'List your schedules in Greenhouse: what each Agent runs when (cron and time zone), and how it last went.',
    input: z.object({ agent_id: agentId.optional() }),
    readOnly: true,
    async run(input, { caller, services }) {
      return { schedules: await services.schedules.list(caller.memberId, input.agent_id) };
    },
  }),

  defineMcpTool({
    name: 'memories_list',
    scopes: ['memories:read'],
    description:
      'List what one of your Greenhouse Agents remembers about you (its memories of you only), pinned first.',
    input: z.object({ agent_id: agentId.default('main') }),
    readOnly: true,
    async run(input, { caller, services }) {
      const memories = await services.agents.memories(caller.memberId, input.agent_id);
      return {
        memories: memories.map((memory) => ({
          id: memory.id,
          title: memory.title,
          content: memory.content,
          category: memory.category,
          pinned: memory.pinned,
          updated_at: memory.updated_at,
        })),
      };
    },
  }),
];

/** The tools this caller's scopes open. */
export function toolsFor(scopes: readonly OAuthScope[]): McpTool[] {
  return MCP_TOOLS.filter((tool) => tool.scopes.some((scope) => scopes.includes(scope)));
}

export function toolContext(caller: Caller, services: McpServices, issuer: string): McpToolContext {
  return {
    caller,
    services,
    exchange: createExchange({
      agents: services.agents,
      conversations: services.conversations,
      engine: services.engine,
      hub: services.hub,
      issuer,
    }),
  };
}
