/**
 * Client Action Executor — runs an agent-requested UI action in the browser.
 *
 * The backend streams a `client-tool-request`; SessionManager dispatches UI
 * actions here. The result is posted back via /api/client-tools/result,
 * resuming the paused agent step.
 */

import { getClientAction } from './registry';

export interface ClientActionResult {
  toolCallId: string;
  output: unknown;
  error?: string;
}

/** Is this tool id a registered web client action (vs a desktop OS tool)? */
export function isClientAction(toolId: string): boolean {
  return getClientAction(toolId) !== undefined;
}

/**
 * Execute a client action request and return a result for the agent.
 * Never throws — failures/denials come back as `{ error }` so the model can adapt.
 */
export async function executeClientAction(
  toolCallId: string,
  toolId: string,
  params: Record<string, unknown>,
): Promise<ClientActionResult> {
  const action = getClientAction(toolId);
  if (!action) {
    return { toolCallId, output: null, error: `Unknown client action: ${toolId}` };
  }

  // Confirm gate for intrusive actions. Navigation / read-current-view are 'auto'.
  if (action.safety === 'confirm') {
    const ok = window.confirm(`Allow the assistant to: ${action.description}?`);
    if (!ok) {
      return { toolCallId, output: null, error: `User declined action: ${toolId}` };
    }
  }

  try {
    const output = await action.execute(params ?? {});
    // Always return *something* serializable so the agent sees a concrete result.
    return { toolCallId, output: output ?? { ok: true } };
  } catch (err) {
    return { toolCallId, output: null, error: err instanceof Error ? err.message : String(err) };
  }
}
