import { isMcpNeedsConnection } from '@greenhouse/types/mcp-servers';
/** Saved external cards run as their viewer; app roles never grant external access. */
import type { DatabaseProvider } from '@greenhouse/db';
import {
  APP_SOURCE_LIMITS,
  readJsonPointer,
  type AppCardQueryResult,
  type AppExternalSource,
  type AppSourceCell,
  type AppSourceErrorReason,
  type AppSourceMap,
} from '@greenhouse/types/apps';
import { callConnectorTool } from '../../mcp-client/gateway.js';
import { createWorkbenchEvaluator } from '../../workbench/evaluate.js';

const error = (reason: AppSourceErrorReason, message: string): AppCardQueryResult => ({
  kind: 'source_error',
  reason,
  message,
});
function number(value: unknown): number {
  const n = Array.isArray(value)
    ? value.length
    : typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n)) throw new Error('The mapped value is not a number.');
  return n;
}
function cell(value: unknown): AppSourceCell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  return (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, APP_SOURCE_LIMITS.cellText);
}
/** Pure declarative mapping; returned strings are rendered as text, never HTML. */
export function mapAppSource(data: unknown, map: AppSourceMap): AppCardQueryResult {
  try {
    if (Buffer.byteLength(JSON.stringify(data) ?? '') > APP_SOURCE_LIMITS.resultBytes)
      return error('too_large', 'The source result exceeds the size limit.');
    if (map.kind === 'kpi') return { kind: 'kpi', value: number(readJsonPointer(data, map.value)) };
    const all = readJsonPointer(data, map.rows);
    if (!Array.isArray(all)) throw new Error('The mapped rows must be an array.');
    const rows = all.slice(0, APP_SOURCE_LIMITS.rows);
    if (map.kind === 'chart')
      return {
        kind: 'chart',
        rows: rows.map((row) => ({
          group: cell(readJsonPointer(row, map.group)),
          value: number(readJsonPointer(row, map.value)),
          ...(map.series !== undefined ? { series: cell(readJsonPointer(row, map.series)) } : {}),
        })),
      };
    return {
      kind: 'table',
      columns: map.columns.map((col) => ({ key: col.key, label: col.label, type: col.type ?? 'text' })),
      rows: rows.map((row) =>
        Object.fromEntries(
          map.columns.map((col) => {
            const value = readJsonPointer(row, col.path);
            return [
              col.key,
              value == null
                ? null
                : col.type === 'number'
                  ? number(value)
                  : col.type === 'boolean'
                    ? value === true || value === 'true'
                    : cell(value),
            ];
          }),
        ),
      ),
      truncated: all.length > rows.length,
    };
  } catch {
    return error('map', 'The source result does not match this card’s mapping.');
  }
}

/** Callers pass the card from openAppSession, never a client-supplied source. */
export async function evaluateAppSource(
  db: DatabaseProvider,
  userId: string,
  source: AppExternalSource,
): Promise<AppCardQueryResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async (): Promise<AppCardQueryResult> => {
    const user = await db.users.getById(userId);
    if (!user || (user.role !== 'team' && user.role !== 'super') || user.status !== 'active')
      return error('not_allowed', 'This source is not available to your account.');
    const { resolveUserTools, createToolRegistry } = await import('../../agent.js');
    const { allowedTools } = await resolveUserTools(user.id, user.role);
    if (controller.signal.aborted) return error('timeout', 'The source did not answer in time.');
    if (source.kind === 'connector') {
      if (!allowedTools.includes('mcp_call'))
        return error('not_allowed', 'Connectors are not available to your account.');
      const result = await callConnectorTool(
        db,
        { userId },
        { server: source.server, tool: source.tool, arguments: source.input },
        { abortSignal: controller.signal, maxBytes: APP_SOURCE_LIMITS.resultBytes },
      );
      if (isMcpNeedsConnection(result)) return { kind: 'needs_connection', connection: result };
      if ('data' in result) return mapAppSource(result.data, source.map);
      return error(
        'reason' in result ? (result.reason ?? 'failed') : 'failed',
        'The connector source could not be evaluated.',
      );
    }
    const { WORKBENCH_READ_TOOL_IDS } = await import('../../tools/registry.js');
    const { buildLazyServerTools } = await import('../../agent-runtime/tool-resolution.js');
    const readableToolIds = allowedTools.filter((id) => WORKBENCH_READ_TOOL_IDS.has(id));
    if (!readableToolIds.includes(source.toolId))
      return error('not_allowed', 'This read tool is not available to your account.');
    const registry = {
      ...createToolRegistry(db),
      ...buildLazyServerTools(db, readableToolIds, { userId, userRole: user.role, workspaceId: null }),
    };
    const evaluator = createWorkbenchEvaluator({ userId, registry, readableToolIds, abortSignal: controller.signal });
    const result = await evaluator.evaluateSource(source);
    return result.ok
      ? mapAppSource(result.data, source.map)
      : error(result.error === 'forbidden' ? 'not_allowed' : 'failed', 'The source could not be evaluated.');
  };
  try {
    return await Promise.race([
      run(),
      new Promise<AppCardQueryResult>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(error('timeout', 'The source did not answer in time.'));
        }, APP_SOURCE_LIMITS.timeoutMs);
      }),
    ]);
  } catch {
    return error('failed', 'The source could not be evaluated.');
  } finally {
    if (timer) clearTimeout(timer);
  }
}
