/**
 * Tables client · Base membership (people). Group members, custom roles and
 * owner transfer land in `./access` (slice A).
 */

import type { TableBaseRole } from '@greenhouse/types/tables';
import { rpc } from '../client';
import { responseError } from './shared';
import type { TableBaseMember } from './bases';

export async function upsertTableBaseMember(
  baseId: number,
  userId: string,
  role: Exclude<TableBaseRole, 'owner'>,
): Promise<TableBaseMember> {
  const args = { param: { baseId: String(baseId), userId }, json: { role } };
  const response = await rpc.api.tables.bases[':baseId'].members[':userId'].$put(args);
  if (!response.ok) throw await responseError(response, 'Unable to update member');
  return (await response.json()).member;
}

export async function removeTableBaseMember(baseId: number, userId: string): Promise<void> {
  const response = await rpc.api.tables.bases[':baseId'].members[':userId'].$delete({
    param: { baseId: String(baseId), userId },
  });
  if (!response.ok) throw await responseError(response, 'Unable to remove member');
}
