/**
 * Process-local cancellation bridge for Mission relay requests.
 *
 * The durable run row remains the admission authority. This registry closes
 * the remaining in-process race: once a provider request is registered, a
 * winning Mission terminal transition aborts it before acknowledging cleanup.
 */

const activeByRun = new Map<string, Set<AbortController>>();

export interface MissionRelayRequestHandle {
  signal: AbortSignal;
  close(): void;
}

export function beginMissionRelayRequest(runId: string): MissionRelayRequestHandle {
  const controller = new AbortController();
  let controllers = activeByRun.get(runId);
  if (!controllers) {
    controllers = new Set();
    activeByRun.set(runId, controllers);
  }
  controllers.add(controller);
  let closed = false;
  return {
    signal: controller.signal,
    close() {
      if (closed) return;
      closed = true;
      controllers!.delete(controller);
      if (controllers!.size === 0) activeByRun.delete(runId);
    },
  };
}

export function abortMissionRelayRequests(runId: string, reason = 'mission_terminal'): number {
  const controllers = activeByRun.get(runId);
  if (!controllers) return 0;
  activeByRun.delete(runId);
  for (const controller of controllers) {
    controller.abort(new Error(reason));
  }
  return controllers.size;
}
