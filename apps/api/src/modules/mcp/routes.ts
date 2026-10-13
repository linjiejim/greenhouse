/**
 * POST /api/mcp     the MCP server (streamable HTTP, stateless, JSON responses). Public route with
 *                   its own credential: a Bearer access token from /oauth/token or a personal
 *                   access token. Without a good one: 401 with the RFC 9728 challenge.
 * GET|DELETE        405: no server-sent stream and no sessions.
 *
 * Every request rebuilds the server for its caller: the tools listed are the ones the token's
 * scopes open, and each runs as the member the token acts for.
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { API_VERSION } from '@greenhouse/contract';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { ApiError, errorBody } from '../../http/errors.js';
import type { AppEnv } from '../../http/env.js';
import { openCors } from '../../security/headers.js';
import { RateLimiter } from '../../security/rate-limit.js';
import { bearerChallenge } from '../oauth/protocol.js';
import type { Caller, OAuthService } from '../oauth/service.js';
import { toolContext, toolsFor, type McpServices, type McpTool } from './tools.js';

const INSTRUCTIONS =
  'Greenhouse is a team workspace where each member works with their own AI Agents. These tools act as one member, ' +
  'with exactly what they granted: the tool list is the permission list. Agents never change shared data without ' +
  "the member's approval in the Greenhouse app; when a reply waits for it, the result says needs_you with a link.";

/** Requests per minute per authorization. */
const PER_MINUTE = 120;

/** The JSON Schema MCP shows for a tool's input. */
function inputSchema(tool: McpTool): { type: 'object'; [key: string]: unknown } {
  const schema = z.toJSONSchema(tool.input, { io: 'input' }) as Record<string, unknown>;
  delete schema.$schema;
  return { ...schema, type: 'object' };
}

function toolResult(value: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], ...(isError ? { isError } : {}) };
}

function buildServer(caller: Caller, services: McpServices, issuer: string): Server {
  const server = new Server(
    { name: 'greenhouse', version: String(API_VERSION) },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  const tools = toolsFor(caller.scopes);
  const ctx = toolContext(caller, services, issuer);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: inputSchema(tool),
      annotations: { readOnlyHint: tool.readOnly, openWorldHint: false },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((entry) => entry.name === request.params.name);
    if (!tool) {
      return toolResult(errorBody('not_found', `No tool "${request.params.name}" is granted to this token.`), true);
    }
    const parsed = tool.input.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      return toolResult(
        errorBody(
          'invalid_input',
          'Some arguments are invalid.',
          parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        ),
        true,
      );
    }
    try {
      return toolResult(await tool.run(parsed.data, ctx));
    } catch (error) {
      if (error instanceof ApiError) return toolResult(errorBody(error.code, error.message, error.details), true);
      logger.error(`[mcp] ${tool.name} failed`, { client: caller.clientId, error: toErrorMessage(error) });
      return toolResult(errorBody('internal', 'Something went wrong. Try again.'), true);
    }
  });

  return server;
}

export function mcpRoutes(deps: { oauth: OAuthService; services: McpServices }) {
  const limiter = new RateLimiter(PER_MINUTE, 60_000);
  const { endpoints } = deps.oauth;

  return new Hono<AppEnv>()
    .use('*', openCors)
    .use(
      '*',
      bodyLimit({
        maxSize: 256 * 1024,
        onError: (c) => c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Body too large.' } }, 413),
      }),
    )
    .all('/', async (c) => {
      const match = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
      const caller = match ? await deps.oauth.authenticate(match[1]!) : null;
      if (!caller) {
        c.header('WWW-Authenticate', bearerChallenge(endpoints, match ? 'invalid_token' : undefined));
        return c.json(errorBody('unauthorized', 'Connect with OAuth or a personal access token.'), 401);
      }
      // Stateless: no stream for server-initiated messages, no session to end.
      if (c.req.method !== 'POST') {
        c.header('Allow', 'POST');
        return c.json(errorBody('method_not_allowed', 'Send JSON-RPC with POST.'), 405);
      }
      const wait = limiter.hit(caller.grantId);
      if (wait) {
        c.header('Retry-After', String(wait));
        return c.json(errorBody('rate_limited', `Too many requests. Try again in ${wait} seconds.`), 429);
      }
      const server = buildServer(caller, deps.services, endpoints.issuer);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      try {
        return await transport.handleRequest(c.req.raw);
      } finally {
        void server.close();
      }
    });
}
