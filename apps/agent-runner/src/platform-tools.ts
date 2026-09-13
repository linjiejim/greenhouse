/**
 * Platform tool bridge — the mission acts with its owner's tool permissions.
 *
 * Fetches the /api/agent runtime manifest with the run's task token (the api
 * resolves the owner's effective tools ∩ proxy allowlists — the sandbox can
 * only ever narrow, never widen) and maps every entry onto a Pi custom tool.
 * Executions round-trip through POST /api/agent/tools/:id/call with the same
 * task token; the api closes this surface the moment the run leaves
 * starting/running.
 *
 * Mutating tools never self-assert confirmation. The api returns a run-bound,
 * exact-input approval lease; this process waits for the owner to decide and
 * retries once with that lease ID.
 */

import { Unsafe } from 'typebox/type';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';

const RESULT_CLIP = 16 * 1024;

interface ManifestEntry {
  id: string;
  name: string;
  description: string;
  category?: string;
  mutating: boolean;
  inputSchema: Record<string, unknown>;
}

interface ApprovalRequiredBody {
  approval?: { id?: string; tool_id?: string; action?: string | null; expires_at?: string };
}

export interface PlatformToolHooks {
  onApprovalRequested?: (approval: { id: string; tool: string; action: string | null; expires_at: string }) => void;
  onManifest?: (metrics: { count: number; schema_bytes: number }) => void;
  /** Permanent audit hooks receive the exact input/output before model-context clipping. */
  onToolStarted?: (call: { tool: string; args: unknown }) => void;
  onToolCompleted?: (call: { tool: string; is_error: boolean; result: string }) => void;
}

function clip(text: string): string {
  return text.length > RESULT_CLIP ? `${text.slice(0, RESULT_CLIP)}…[clipped]` : text;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Tool call aborted'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Tool call aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForApproval(
  apiBase: string,
  taskToken: string,
  approvalId: string,
  signal?: AbortSignal,
): Promise<void> {
  for (;;) {
    await wait(3_000, signal);
    const res = await fetch(`${apiBase}/api/agent/approvals/${encodeURIComponent(approvalId)}`, {
      headers: { Authorization: `Bearer ${taskToken}` },
      signal: signal ?? null,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Approval check failed (${res.status}): ${clip(text)}`);
    let status: string | undefined;
    try {
      status = (JSON.parse(text) as { approval?: { status?: string } }).approval?.status;
    } catch {
      throw new Error('Approval check returned invalid JSON');
    }
    if (status === 'approved') return;
    if (status === 'denied') throw new Error('User denied this platform mutation');
    if (status === 'expired') throw new Error('Platform mutation approval expired');
    if (status === 'consumed') throw new Error('Platform mutation approval was already used');
    if (status !== 'pending') throw new Error(`Unexpected approval status: ${status ?? 'missing'}`);
  }
}

export async function loadPlatformTools(
  apiBase: string,
  taskToken: string,
  hooks: PlatformToolHooks = {},
): Promise<ToolDefinition[]> {
  let entries: ManifestEntry[];
  try {
    const res = await fetch(`${apiBase}/api/agent/runtime-manifest`, {
      headers: { Authorization: `Bearer ${taskToken}` },
    });
    if (!res.ok) {
      console.error(`[runner] runtime-manifest rejected (${res.status}) — continuing without platform tools`);
      return [];
    }
    entries = ((await res.json()) as { tools?: ManifestEntry[] }).tools ?? [];
  } catch (err) {
    console.error('[runner] runtime-manifest unreachable — continuing without platform tools:', String(err));
    return [];
  }

  hooks.onManifest?.({
    count: entries.length,
    schema_bytes: Buffer.byteLength(JSON.stringify(entries.map((entry) => entry.inputSchema))),
  });

  return entries.map((entry) =>
    defineTool({
      name: entry.id,
      label: entry.name || entry.id,
      description: entry.mutating
        ? `${entry.description}\n\n[Platform WRITE tool — the user must approve the exact action before it executes.]`
        : entry.description,
      parameters: Unsafe(entry.inputSchema as never),
      async execute(_toolCallId, params, signal) {
        hooks.onToolStarted?.({ tool: entry.id, args: params ?? {} });
        let completionRecorded = false;
        const recordCompletion = (isError: boolean, result: string) => {
          completionRecorded = true;
          hooks.onToolCompleted?.({ tool: entry.id, is_error: isError, result });
        };
        const call = async (approvalId?: string) => {
          const res = await fetch(`${apiBase}/api/agent/tools/${encodeURIComponent(entry.id)}/call`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${taskToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ input: params ?? {}, ...(approvalId ? { approval_id: approvalId } : {}) }),
            signal: signal ?? null,
          });
          const text = await res.text();
          return { res, text };
        };

        try {
          let { res, text } = await call();
          if (res.status === 428) {
            let required: ApprovalRequiredBody;
            try {
              required = JSON.parse(text) as ApprovalRequiredBody;
            } catch {
              throw new Error(`${entry.id} requires approval but returned invalid JSON`);
            }
            const approval = required.approval;
            if (!approval?.id) throw new Error(`${entry.id} requires approval but returned no lease ID`);
            hooks.onApprovalRequested?.({
              id: approval.id,
              tool: entry.id,
              action: approval.action ?? null,
              expires_at: approval.expires_at ?? '',
            });
            await waitForApproval(apiBase, taskToken, approval.id, signal ?? undefined);
            ({ res, text } = await call(approval.id));
          }
          if (!res.ok) {
            recordCompletion(true, text);
            throw new Error(`${entry.id} failed (${res.status}): ${clip(text)}`);
          }
          recordCompletion(false, text);
          return { content: [{ type: 'text' as const, text: clip(text) }], details: undefined };
        } catch (error) {
          if (!completionRecorded) recordCompletion(true, error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
    }),
  );
}
