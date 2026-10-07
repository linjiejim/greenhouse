/**
 * The one error a computer consumer (tools, routes, viewer) handles: the
 * member's computer can't be used right now, with a code the caller can turn
 * into a member-facing sentence. Re-exported by access.ts, the public seam.
 */

export type ComputerUnavailableCode =
  | 'disabled'
  | 'unavailable'
  | 'busy'
  | 'start_failed'
  | 'user_in_control'
  | 'stopped'
  | 'over_quota';

export class ComputerUnavailableError extends Error {
  constructor(
    readonly code: ComputerUnavailableCode,
    message: string,
    /**
     * What `over_quota` is about when it is not the member's own home:
     * `host_disk` = the Docker host's disk is nearly full (an admin's job,
     * nothing the member can clean up).
     */
    readonly reason?: 'host_disk',
  ) {
    super(message);
    this.name = 'ComputerUnavailableError';
  }
}
