/** Load misses that mean "not for you" rather than "try again". React-free. */

import type { ApiMiss } from '../api/client';

/** A 403: the role, a feature flag or a capability keeps this member out — a retry won't help. */
export function noAccess(error: ApiMiss | null | undefined): boolean {
  return error?.status === 403;
}

/** A 404: the thing is gone, or not visible to this member (the server does not say which). */
export function notFound(error: ApiMiss | null | undefined): boolean {
  return error?.status === 404;
}
