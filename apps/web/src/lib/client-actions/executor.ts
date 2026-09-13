/**
 * Client Action Executor — runs an agent-requested UI action in the browser.
 *
 * The backend streams a `local-tool-request`; SessionManager dispatches registered
 * UI actions here. The result is posted to `/api/client-actions/tool-result`,
 * resuming the paused agent step.
 */

import { GLOBAL_CLIENT_ACTION_SCOPE, resolveClientAction } from './registry';
import { requestConfirmation } from './confirm-gate';
import { isPageActionScopeActive } from '../page-action-scope';

export interface ClientActionResult {
  toolCallId: string;
  output: unknown;
  error?: string;
}

/**
 * Execute a client action request and return a result for the agent.
 * Never throws — failures/denials come back as `{ error }` so the model can adapt.
 */
export async function executeClientAction(
  toolCallId: string,
  toolId: string,
  params: Record<string, unknown>,
  scopeId?: string,
): Promise<ClientActionResult> {
  // Without a scope only global actions are reachable, which is the right
  // fail-closed shape: a page action with no page scope can never be resolved.
  const resolved = resolveClientAction(scopeId ?? GLOBAL_CLIENT_ACTION_SCOPE, toolId);
  if (!resolved) {
    return { toolCallId, output: null, error: `Unknown client action: ${toolId}` };
  }

  // Page actions expire with the route that declared them. Global ones (desktop
  // native capture, the browser bridge) are not bound to any route, so expiring
  // them would only break long turns — see registry.ts.
  if (resolved.origin === 'page' && !isPageActionScopeActive(scopeId!)) {
    return {
      toolCallId,
      output: null,
      error: 'The page context changed before this action could run. Ask the user to retry from the current page.',
    };
  }

  const action = resolved.action;

  // Confirm gate for intrusive actions. Navigation / read-current-view are 'auto'.
  if (action.safety === 'confirm') {
    const { allowed } = await requestConfirmation({
      title: 'Allow this action?',
      description: action.description,
    });
    if (!allowed) {
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
