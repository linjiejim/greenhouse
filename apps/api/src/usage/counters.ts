/**
 * Module usage counting — the API side of `usage_counters`.
 *
 * Counts are fire-and-forget: `countUsage()` never throws, never awaits the
 * database, and logs a warning when the write fails. A counter must never fail
 * or slow the tool call or page view it describes.
 *
 * Tool calls are counted at their real execution boundaries, once each:
 *   - `countToolCalls()` wraps a per-turn registry (Chat, Automation,
 *     the Feishu bot) so the count fires when `execute` is entered;
 *   - `executeProxyTool({ usageClient })` counts MCP and Agent API calls after
 *     the proxy's reachability / confirm / schema checks pass.
 */

import type { Context } from 'hono';
import { getDb, usageDay, type DatabaseProvider, type UsageCounterKind } from '@greenhouse/db';
import type { SessionChannel } from '@greenhouse/types/session';
import {
  APP_CLIENT_HEADER,
  parseAppClient,
  type PageOpenClient,
  type ToolCallClient,
  type UsageRangeDays,
} from '@greenhouse/types/usage';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { ToolRegistry } from '../agent.js';

/** Bump a counter without waiting for it; a failure is logged, never thrown. */
export function countUsage(
  kind: UsageCounterKind,
  key: string,
  client: string,
  db: () => DatabaseProvider = getDb,
): void {
  try {
    db()
      .usageCounters.increment(kind, key, client)
      .catch((err: unknown) => {
        logger.warn(`[usage] could not count ${kind} ${key} (${client}): ${toErrorMessage(err)}`);
      });
  } catch (err) {
    logger.warn(`[usage] could not count ${kind} ${key} (${client}): ${toErrorMessage(err)}`);
  }
}

/**
 * A copy of `tools` whose `execute` functions count one `tool_call` per call
 * before running the original. The input registry (often the shared one) is
 * never mutated. Callers pass only catalog tools: client-declared actions carry
 * names chosen by the browser and must not become counter keys.
 */
export function countToolCalls(
  tools: ToolRegistry | undefined,
  client: ToolCallClient,
  db?: () => DatabaseProvider,
): ToolRegistry {
  if (!tools) return {};
  const counted: ToolRegistry = {};
  for (const [toolName, definition] of Object.entries(tools)) {
    if (!definition || typeof definition !== 'object' || typeof definition.execute !== 'function') {
      counted[toolName] = definition;
      continue;
    }
    const original = definition.execute;
    counted[toolName] = {
      ...definition,
      execute: (input: unknown, options: unknown) => {
        countUsage('tool_call', toolName, client, db);
        return original.call(definition, input, options);
      },
    };
  }
  return counted;
}

/** The first-party app a request came from (`X-Greenhouse-Client`), or null for the plain web app. */
export function requestAppClient(c: Context): ReturnType<typeof parseAppClient> {
  return parseAppClient(c.req.header(APP_CLIENT_HEADER));
}

/** Who ran a chat turn: the session channel wins, then the app header, else the web app. */
export function chatToolCallClient(
  channel: SessionChannel | undefined,
  appClient: ReturnType<typeof parseAppClient>,
): ToolCallClient {
  if (channel === 'browser') return 'browser';
  if (channel === 'feishu') return 'feishu';
  if (appClient === 'mobile') return appClient;
  return 'web_chat';
}

/** Agent API calls from the mobile app count as that app. */
export function agentApiToolCallClient(appClient: ReturnType<typeof parseAppClient>): ToolCallClient {
  return appClient === 'mobile' ? appClient : 'agent_api';
}

/** Page opens: the app header names the mobile app, anything else is the web app. */
export function pageOpenClient(appClient: ReturnType<typeof parseAppClient>): PageOpenClient {
  return appClient ?? 'web';
}

/** The inclusive UTC day range ending today that a `days`-long report covers. */
export function usageDayRange(days: UsageRangeDays, now: Date = new Date()): { from: string; to: string } {
  const from = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  return { from: usageDay(from), to: usageDay(now) };
}
