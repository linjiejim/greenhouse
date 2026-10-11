/**
 * Tables client · Base membership (people). Group members, custom roles and
 * owner transfer land in `./access` (slice A).
 */

import { rpc } from '../client';
import { responseError } from './shared';

export async function removeTableBaseMember(baseId: number, userId: string): Promise<void> {
  const response = await rpc.api.tables.bases[':baseId'].members[':userId'].$delete({
    param: { baseId: String(baseId), userId },
  });
  if (!response.ok) throw await responseError(response, 'Unable to remove member');
}
