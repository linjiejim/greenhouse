import { and, asc, eq, gt, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import {
  getDb,
  groupMembers,
  groups,
  members,
  newId,
  refreshTokens,
  transaction,
  type Db,
  type Member,
  type MemberModules as StoredModules,
} from '@greenhouse/db';
import { audit, changedFields } from '../../audit.js';
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
import { containing } from '../../http/like.js';
import { toPage, decodeCursor } from '../../http/pagination.js';
import type { ProvidersService } from '../../providers/service.js';
import type { AuthService } from '../auth/service.js';
import type { FilesService } from '../files/service.js';

const DEFAULT_MODULES: MemberModules = { knowledge: true, tables: true, apps: true, computer: true };

export function effectiveModules(stored: StoredModules): MemberModules {
  return { ...DEFAULT_MODULES, ...stored };
}

/** What anyone may see about a member, for one reader: the avatar URL is signed for them. */
export function summaryFor(files: Pick<FilesService, 'signedUrl'>, readerId: string) {
  return (row: Member): MemberSummary => ({
    id: row.id,
    name: row.name,
    email: row.email,
    avatar_url: row.avatarFileId ? files.signedUrl(row.avatarFileId, readerId).url : null,
  });
}

const toMe = (row: Member, capabilities: Me['capabilities'], files: Pick<FilesService, 'signedUrl'>): Me => ({
  ...summaryFor(files, row.id)(row),
  role: row.role,
  locale: row.locale,
  timezone: row.timezone,
  theme: row.theme,
  about: row.about,
  modules: effectiveModules(row.modules),
  notification_settings: row.notificationSettings,
  capabilities,
});

const toAdmin = (row: Member, summary: (row: Member) => MemberSummary): MemberAdmin => ({
  ...summary(row),
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

export function createMembersService(deps: { auth: AuthService; providers: ProvidersService; files: FilesService }) {
  /** What the member can use now: their own keys where the policy allows, else the workspace's. */
  const capabilitiesOf = (memberId: string) => deps.providers.availability({ memberId });

  return {
    async me(memberId: string): Promise<Me> {
      return toMe(await load(getDb(), memberId), await capabilitiesOf(memberId), deps.files);
    },

    /** A new avatar must be my own picture uploaded as an avatar; the one it replaces is deleted. */
    async updateMe(memberId: string, input: UpdateMeInput): Promise<Me> {
      if (input.avatar_file_id) await deps.files.ownPicture(memberId, input.avatar_file_id, 'avatar');
      const { row, replaced } = await transaction(async (db) => {
        const before = await load(db, memberId);
        const [row] = await db
          .update(members)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.locale !== undefined ? { locale: input.locale } : {}),
            ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
            ...(input.theme !== undefined ? { theme: input.theme } : {}),
            ...(input.about !== undefined ? { about: input.about } : {}),
            ...(input.notification_settings !== undefined ? { notificationSettings: input.notification_settings } : {}),
            ...(input.avatar_file_id !== undefined ? { avatarFileId: input.avatar_file_id } : {}),
            updatedAt: sql`now()`,
          })
          .where(eq(members.id, memberId))
          .returning();
        const replaced =
          input.avatar_file_id !== undefined && before.avatarFileId && before.avatarFileId !== input.avatar_file_id
            ? before.avatarFileId
            : null;
        return { row: row!, replaced };
      });
      if (replaced) await deps.files.discard(replaced);
      return toMe(row, await capabilitiesOf(memberId), deps.files);
    },

    /** Bumps auth_version: every other session ends; the caller signs in again. */
    async changePassword(memberId: string, current: string, next: string): Promise<void> {
      await transaction(async (db) => {
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

    /** Everyone a member can pick when sharing or mentioning (no admin-only fields), by name or email. */
    async directory(readerId: string, query: { q?: string; limit?: number } = {}): Promise<MemberSummary[]> {
      const matching = getDb()
        .select()
        .from(members)
        .where(
          and(
            eq(members.status, 'active'),
            query.q
              ? or(ilike(members.name, containing(query.q)), ilike(members.email, containing(query.q)))
              : undefined,
          ),
        )
        .orderBy(asc(members.name), asc(members.id));
      const rows = query.limit ? await matching.limit(query.limit) : await matching;
      return rows.map(summaryFor(deps.files, readerId));
    },

    async list(readerId: string, query: { cursor?: string; limit: number }): Promise<Page<MemberAdmin>> {
      const after = decodeCursor(query.cursor);
      const rows = await getDb()
        .select()
        .from(members)
        .where(after ? gt(members.id, after) : undefined)
        .orderBy(asc(members.id))
        .limit(query.limit + 1);
      const summary = summaryFor(deps.files, readerId);
      return toPage(rows, query.limit, (row) => toAdmin(row, summary));
    },

    async invite(actorId: string, input: InviteInput): Promise<InviteResult> {
      return transaction(async (db) => {
        const [existing] = await db.select({ id: members.id }).from(members).where(eq(members.email, input.email));
        if (existing) throw conflict('email_taken', 'Someone with this email is already a member.');
        const [row] = await db
          .insert(members)
          .values({ id: newId('member'), email: input.email, name: input.name, role: input.role ?? 'member' })
          .returning();
        const link = await deps.auth.issueLink(db, row!, 'activate');
        await audit({
          actorId,
          action: 'member.invite',
          resourceType: 'member',
          resourceId: row!.id,
          summary: row!.role,
        });
        return { member: toAdmin(row!, summaryFor(deps.files, actorId)), link };
      });
    },

    async update(actorId: string, memberId: string, input: UpdateMemberInput): Promise<MemberAdmin> {
      return transaction(async (db) => {
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
        await audit({
          actorId,
          action: 'member.update',
          resourceType: 'member',
          resourceId: memberId,
          summary: changedFields(input),
        });
        return toAdmin(updated!, summaryFor(deps.files, actorId));
      });
    },

    async issueResetLink(actorId: string, memberId: string): Promise<IssuedLink> {
      return transaction(async (db) => {
        const row = await load(db, memberId);
        if (row.status === 'disabled') throw conflict('member_disabled', 'Reactivate the member first.');
        const purpose = row.passwordHash ? 'reset' : 'activate';
        await audit({ actorId, action: 'member.link', resourceType: 'member', resourceId: memberId, summary: purpose });
        return deps.auth.issueLink(db, row, purpose);
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
      return transaction(async (db) => {
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
        await audit({
          actorId,
          action: groupId ? 'group.update' : 'group.create',
          resourceType: 'group',
          resourceId: id,
        });
        const all = await this.listGroups();
        return all.find((group) => group.id === id)!;
      });
    },

    async deleteGroup(actorId: string, groupId: string): Promise<void> {
      await transaction(async (db) => {
        const deleted = await db.delete(groups).where(eq(groups.id, groupId)).returning({ id: groups.id });
        if (!deleted.length) throw notFound('Group');
        await audit({ actorId, action: 'group.delete', resourceType: 'group', resourceId: groupId });
      });
    },
  };
}

export type MembersService = ReturnType<typeof createMembersService>;
