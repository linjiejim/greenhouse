import type { PlatformActionRequest, PlatformActionResult } from '@greenhouse/platform-kernel';
import { getPlatformRuntime } from './runtime.js';

/** Custom routes bind their command to the same capability guard and audit as tools. */
export async function recordWrite(
  request: PlatformActionRequest,
  operation: () => Promise<PlatformActionResult>,
): Promise<PlatformActionResult> {
  const runtime = getPlatformRuntime();
  if (runtime.getManifest(request.appId)?.actions[request.actionId]?.kind !== 'command')
    throw new Error('recordWrite requires a registered command');
  return runtime.dispatch(request, operation);
}

export { notify } from '../notifications/publish.js';
