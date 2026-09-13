/** Attach owner display names to foreign-owned rows without widening access. */

import type { DatabaseProvider } from '@greenhouse/db';

export async function withOwnerNicknames<T extends { user_id?: string | null }>(
  db: DatabaseProvider,
  rows: T[],
  viewerId: string,
): Promise<(T & { owner_nickname?: string })[]> {
  const foreignOwnerIds = [
    ...new Set(rows.map((row) => row.user_id).filter((id): id is string => Boolean(id) && id !== viewerId)),
  ];
  if (foreignOwnerIds.length === 0) return rows;

  const owners = await Promise.all(foreignOwnerIds.map((id) => db.users.getById(id)));
  const nicknameById = new Map(foreignOwnerIds.map((id, index) => [id, owners[index]?.nickname]));
  return rows.map((row) => {
    const nickname = row.user_id ? nicknameById.get(row.user_id) : undefined;
    return nickname ? { ...row, owner_nickname: nickname } : row;
  });
}
