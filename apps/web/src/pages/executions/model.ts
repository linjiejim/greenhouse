import { isRuntimeRunActive, type RuntimeRun, type RuntimeTransport } from '@greenhouse/types/runtime';
export { executionRunHref, parseExecutionSubPath } from '../../lib/execution-route';

export type RuntimeConnectionState = 'disconnected' | 'connecting' | 'connected';

function objectPayload(value: RuntimeRun['input']): Record<string, unknown> | null {
  return value !== null && !Array.isArray(value) && typeof value === 'object' ? value : null;
}

function firstDisplayString(input: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function nestedObject(input: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = input[key];
  return value !== null && !Array.isArray(value) && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

export function runtimeRunTitle(run: RuntimeRun): string {
  const input = objectPayload(run.input);
  if (input && run.kind === 'agent_write') {
    const client = firstDisplayString(input, ['client_name']) ?? 'Agent';
    return `${client} · ${firstDisplayString(input, ['action', 'tool_id']) ?? run.source_id}`;
  }
  const automationTask = input && run.kind === 'automation' ? nestedObject(input, 'task') : null;
  const title =
    (input ? firstDisplayString(input, ['title', 'name', 'session_title', 'prompt', 'task', 'task_input']) : null) ??
    (automationTask ? firstDisplayString(automationTask, ['name']) : null);
  if (title) return title.split('\n')[0]!.trim();
  return run.source_id || run.id;
}

export function runtimeTransport(
  run: RuntimeRun,
  now = Date.now(),
  connection: RuntimeConnectionState = 'connected',
): RuntimeTransport {
  if (connection === 'connecting') return 'reconnecting';
  if (connection === 'disconnected') return 'offline';
  if (!isRuntimeRunActive(run.status)) return 'live';
  if (run.lease_expires_at && Date.parse(run.lease_expires_at) < now) return 'stale';
  return 'live';
}

export function payloadText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  return JSON.stringify(payload, null, 2);
}
