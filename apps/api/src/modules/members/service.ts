import { and, asc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  getDb,
  groupMembers,
  groups,
  members,
  newId,
  refreshTokens,
  type Db,
  type Member,
  type MemberModules as StoredModules,
} from '@greenhouse/db';
import type {
  Group,
  GroupInput,
  InviteInput,
  InviteResult,
  IssuedLink,
  Me,
  MemberAdmin,
  MemberModules,
  MemberSummary,
  Page,
  UpdateMeInput,
  UpdateMemberInput,
} from '@greenhouse/contract';
import { hashPassword, verifyPassword } from '../../auth/password.js';
import { ApiError, conflict, notFound } from '../../http/errors.js';
import { toPage, decodeCursor } from '../../http/pagination.js';
import type { AuthService } from '../auth/service.js';

const DEFAULT_MODULES: MemberModules = { knowledge: true, tables: true, apps: true, computer: true };

export function effectiveModules(stored: StoredModules): MemberModules {
  return { ...DEFAULT_MODULES, ...stored };
}

const avatarUrl = (row: Pick<Member, 'avatarFileId'>) =>
  row.avatarFileId ? `/api/files/${row.avatarFileId}/content` : null;

export const toSummary = (row: Member): MemberSummary => ({
  id: row.id,
  name: row.name,
  email: row.email,
  avatar_url: avatarUrl(row),
});

const toMe = (row: Member): Me => ({
  ...toSummary(row),
  role: row.role,
  locale: row.locale,
  timezone: row.timezone,
  theme: row.theme,
  about: row.about,
  modules: effectiveModules(row.modules),
  notification_settings: row.notificationSettings,
});

const toAdmin = (row: Member): MemberAdmin => ({
  ...toSummary(row),
  role: row.role,
  status: row.status,
  modules: effectiveModules(row.modules),
  last_login_at: row.lastLoginAt,
  created_at: row.createdAt,
});

async function load(db: Db, id: string): Promise<Member> {
  const [row] = await db.select().from(members).where(eq(members.id, id)).limit(1);
  if (!row) throw notFound('Member');
  return row;
}

async function activeAdminCount(db: Db, excluding: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(members)
    .where(and(eq(members.role, 'admin'), eq(members.status, 'active'), ne(members.id, excluding)));
  return row?.n ?? 0;
}

export function createMembersService(deps: { auth: AuthService }) {
  return {
    async me(memberId: string): Promise<Me> {
      return toMe(await load(getDb(), memberId));
    },

    async updateMe(memberId: string, input: UpdateMeInput): Promise<Me> {
      const [row] = await getDb()
        .update(members)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.locale !== undefined ? { locale: input.locale } : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          ...(input.theme !== undefined ? { theme: input.theme } : {}),
          ...(input.about !== undefined ? { about: input.about } : {}),
          ...(input.notification_settings !== undefined ? { notificationSettings: input.notification_settings } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(members.id, memberId))
        .returning();
      if (!row) throw notFound('Member');
      return toMe(row);
    },

    /** Bumps auth_version: every other session ends; the caller signs in again. */
    async changePassword(memberId: string, current: string, next: string): Promise<void> {
      await getDb().transaction(async (tx) => {
        const db = tx as unknown as Db;
        const row = await load(db, memberId);
        if (!(await verifyPassword(current, row.passwordHash))) {
          throw new ApiError(400, 'invalid_credentials', 'The current password is incorrect.');
        }
        await db
          .update(members)
          .set({ passwordHash: await hashPassword(next), authVersion: row.authVersion + 1, updatedAt: sql`now()` })
          .where(eq(members.id, memberId));
        await db
          .update(refreshTokens)
          .set({ consumedAt: sql`now()` })
          .where(and(eq(refreshTokens.memberId, memberId), isNull(refreshTokens.consumedAt)));
      });
    },

    /** Everyone a member can pick when sharing or mentioning (no admin-only fields). */
    async directory(): Promise<MemberSummary[]> {
      const rows = await getDb().select().from(members).where(eq(members.status, 'active')).orderBy(asc(members.name));
      return rows.map(toSummary);
    },

    async list(query: { cursor?: string; limit: number }): Promise<Page<MemberAdmin>> {
      const after = decodeCursor(query.cursor);
      const rows = await getDb()
        .select()
        .from(members)
        .where(after ? gt(members.id, after) : undefined)
        .orderBy(asc(members.id))
        .limit(query.limit + 1);
      return toPage(rows, query.limit, toAdmin);
    },

    async invite(input: InviteInput): Promise<InviteResult> {
      return getDb().transaction(async (tx) => {
        const db = tx as unknown as Db;
        const [existing] = await db.select({ id: members.id }).from(members).where(eq(members.email, input.email));
        if (existing) throw conflict('email_taken', 'Someone with this email is already a member.');
        const [row] = await db
          .insert(members)
          .values({ id: newId('member'), email: input.email, name: input.name, role: input.role ?? 'member' })
          .returning();
        const link = await deps.auth.issueLink(db, row!, 'activate');
        return { member: toAdmin(row!), link };
      });
    },

    async update(actorId: string, memberId: string, input: UpdateMemberInput): Promise<MemberAdmin> {
      return getDb().transaction(async (tx) => {
        const db = tx as unknown as Db;
        const row = await load(db, memberId);
        const demotes = input.role === 'member' && row.role === 'admin';
        const disables = input.status === 'disabled' && row.status !== 'disabled';
        if ((demotes || disables) && row.role === 'admin' && (await activeAdminCount(db, row.id)) === 0) {
          throw conflict('last_admin', 'Keep at least one active admin.');
        }
        if (disables && memberId === actorId) throw conflict('cannot_disable_self', 'You cannot disable yourself.');
        const reactivates = input.status === 'active' && row.status === 'disabled';
        const [updated] = await db
          .update(members)
          .set({
            ...(input.role !== undefined ? { role: input.role } : {}),
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.modules !== undefined ? { modules: { ...row.modules, ...input.modules } } : {}),
            ...(disables ? { status: 'disabled' as const, authVersion: row.authVersion + 1 } : {}),
            // A disabled member who never set a password goes back to invited.
            ...(reactivates ? { status: row.passwordHash ? ('active' as const) : ('invited' as const) } : {}),
            updatedAt: sql`now()`,
          })
          .where(eq(members.id, memberId))
          .returning();
        if (disables || demotes) {
          await db
            .update(refreshTokens)
            .set({ consumedAt: sql`now()` })
            .where(and(eq(refreshTokens.memberId, memberId), isNull(refreshTokens.consumedAt)));
        }
        return toAdmin(updated!);
      });
    },

    async issueResetLink(memberId: string): Promise<IssuedLink> {
      return getDb().transaction(async (tx) => {
        const db = tx as unknown as Db;
        const row = await load(db, memberId);
        if (row.status === 'disabled') throw conflict('member_disabled', 'Reactivate the member first.');
        return deps.auth.issueLink(db, row, row.passwordHash ? 'reset' : 'activate');
      });
    },

    async listGroups(): Promise<Group[]> {
      const db = getDb();
      const rows = await db.select().from(groups).orderBy(asc(groups.name));
      const links = rows.length
        ? await db
            .select()
            .from(groupMembers)
            .where(
              inArray(
                groupMembers.groupId,
                rows.map((row) => row.id),
              ),
            )
        : [];
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        member_ids: links.filter((link) => link.groupId === row.id).map((link) => link.memberId),
      }));
    },

    async saveGroup(actorId: string, input: GroupInput, groupId?: string): Promise<Group> {
      return getDb().transaction(async (tx) => {
        const db = tx as unknown as Db;
        const id = groupId ?? newId('group');
        const [clash] = await db
          .select({ id: groups.id })
          .from(groups)
          .where(and(eq(groups.name, input.name), ne(groups.id, id)));
        if (clash) throw conflict('group_name_taken', 'A group with this name already exists.');
        if (groupId) {
          const [updated] = await db
            .update(groups)
            .set({ name: input.name, description: input.description ?? '', updatedAt: sql`now()` })
            .where(eq(groups.id, groupId))
            .returning();
          if (!updated) throw notFound('Group');
          await db.delete(groupMembers).where(eq(groupMembers.groupId, groupId));
        } else {
          await db
            .insert(groups)
            .values({ id, name: input.name, description: input.description ?? '', createdBy: actorId });
        }
        const memberIds = [...new Set(input.member_ids ?? [])];
        if (memberIds.length) {
          const known = await db.select({ id: members.id }).from(members).where(inArray(members.id, memberIds));
          await db.insert(groupMembers).values(known.map((member) => ({ groupId: id, memberId: member.id })));
        }
        const all = await this.listGroups();
        return all.find((group) => group.id === id)!;
      });
    },

    async deleteGroup(groupId: string): Promise<void> {
      const deleted = await getDb().delete(groups).where(eq(groups.id, groupId)).returning({ id: groups.id });
      if (!deleted.length) throw notFound('Group');
    },
  };
}

export type MembersService = ReturnType<typeof createMembersService>;
