import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetProvider,
  initDatabase,
  UNSET_ACCOUNT_PASSWORD_HASH,
  type DatabaseProvider,
  type UserRole,
  type UserStatus,
} from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { logger } from '@greenhouse/utils/logger';
import { bootstrapFirstAdmin, isFirstRunSetupPending, type FirstAdminOutcome } from './first-admin.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import bootstrapRoutes from '../routes/bootstrap.js';

let db: DatabaseProvider;
const email = () => `portable-${crypto.randomUUID()}@test.local`;
function token(outcome: FirstAdminOutcome): string {
  if (outcome.status !== 'issued') throw new Error(`Expected issued, got ${outcome.status}`);
  return new URLSearchParams(outcome.link.split('#')[1]).get('token')!;
}
async function account(role: UserRole, status: UserStatus) {
  return db.users.create({
    email: email(),
    nickname: 'Existing',
    role,
    status,
    password_hash: UNSET_ACCOUNT_PASSWORD_HASH,
  });
}
beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  vi.spyOn(logger, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  _resetProvider();
});

describe('first administrator', () => {
  it('creates an invited super, binds the platform role, audits as that user and activates once', async () => {
    const address = email();
    expect(await isFirstRunSetupPending(db)).toBe(true);
    const issued = await bootstrapFirstAdmin(db, {
      BOOTSTRAP_ADMIN_EMAIL: ` ${address} `,
      BOOTSTRAP_ADMIN_NAME: ' Owner ',
      PUBLIC_BASE_URL: 'https://hub.example/',
    });
    expect(issued).toMatchObject({
      status: 'issued',
      link: expect.stringMatching(/^https:\/\/hub.example\/activate#token=/),
    });
    const user = (await db.users.getByEmail(address))!;
    expect(user).toMatchObject({
      nickname: 'Owner',
      role: 'super',
      status: 'invited',
      password_hash: UNSET_ACCOUNT_PASSWORD_HASH,
    });
    const superRole = (await db.platform.listRoles()).find((role) => role.code === 'super')!;
    expect(await db.platform.listRoleBindings([superRole.id])).toContainEqual(
      expect.objectContaining({ user_id: user.id }),
    );
    const audit = (await db.platform.listAuditEvents('default')).find((row) => row.actor_id === user.id);
    expect(audit).toMatchObject({ actor_id: user.id, action_id: 'bootstrapFirstAdmin' });
    expect(JSON.stringify(audit)).not.toContain(token(issued));
    const link = await db.accountPasswordLinks.inspect(token(issued));
    expect(link?.link).toMatchObject({ purpose: 'invite', created_by: user.id });
    const passwordHash = await hashPassword('portable-password');
    const completed = await db.accountPasswordLinks.complete(token(issued), passwordHash);
    expect(completed?.user.status).toBe('active');
    expect(await verifyPassword('portable-password', completed!.user.password_hash)).toBe(true);
    expect(await db.accountPasswordLinks.complete(token(issued), passwordHash)).toBeNull();
    expect(await isFirstRunSetupPending(db)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(issued.status === 'issued' ? issued.link : ''));
  });

  it('reissues for the same invited super, revoking the previous link and repairing its binding', async () => {
    const user = await account('super', 'invited');
    const env = { BOOTSTRAP_ADMIN_EMAIL: user.email };
    const first = await bootstrapFirstAdmin(db, env);
    const second = await bootstrapFirstAdmin(db, env);
    expect(token(second)).not.toBe(token(first));
    expect(await db.accountPasswordLinks.inspect(token(first))).toBeNull();
    expect((await db.accountPasswordLinks.inspect(token(second)))?.user.id).toBe(user.id);
    expect((await db.users.getById(user.id))?.nickname).toBe('Existing');
  });

  it.each(['active', 'reset_required'] as const)(
    'is completely inert with an established %s super, even with invalid env',
    async (status) => {
      await account('super', status);
      const lookup = vi.spyOn(db.users, 'getByEmail');
      const create = vi.spyOn(db.users, 'create');
      const bind = vi.spyOn(db.platform, 'syncLegacyRoleBinding');
      const invite = vi.spyOn(db.accountPasswordLinks, 'issueInvite');
      expect(await bootstrapFirstAdmin(db, { BOOTSTRAP_ADMIN_EMAIL: 'bad' })).toEqual({ status: 'established' });
      for (const spy of [lookup, create, bind, invite, logger.warn, logger.error]) expect(spy).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['team', 'active'],
    ['team', 'invited'],
    ['team', 'disabled'],
    ['team', 'reset_required'],
    ['super', 'disabled'],
    ['external', 'disabled'],
  ] as const)('never changes an existing %s/%s account', async (role, status) => {
    const user = await account(role, status);
    const invite = vi.spyOn(db.accountPasswordLinks, 'issueInvite');
    const bind = vi.spyOn(db.platform, 'syncLegacyRoleBinding');
    expect(await bootstrapFirstAdmin(db, { BOOTSTRAP_ADMIN_EMAIL: user.email })).toEqual({ status: 'conflict' });
    expect(await db.users.getById(user.id)).toEqual(user);
    expect(invite).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('warns with setup instructions when unset, and rejects an invalid email without creating a user', async () => {
    const create = vi.spyOn(db.users, 'create');
    expect(await bootstrapFirstAdmin(db, {})).toEqual({ status: 'unconfigured' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('pnpm cli users create --role super'));
    expect(await bootstrapFirstAdmin(db, { BOOTSTRAP_ADMIN_EMAIL: 'bad' })).toEqual({ status: 'invalid_email' });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([undefined, 'garbage', 'ftp://hub.example', 'https://secret@hub.example', 'https://hub.example?token=x'])(
    'logs a relative link and a PUBLIC_BASE_URL hint for %s',
    async (base) => {
      const issued = await bootstrapFirstAdmin(db, { BOOTSTRAP_ADMIN_EMAIL: email(), PUBLIC_BASE_URL: base });
      expect(issued).toMatchObject({ status: 'issued', link: expect.stringMatching(/^\/activate#token=/) });
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('set PUBLIC_BASE_URL'));
    },
  );

  it('accepts an http base and defaults the nickname to the email local part', async () => {
    const address = email();
    const issued = await bootstrapFirstAdmin(db, {
      BOOTSTRAP_ADMIN_EMAIL: address,
      PUBLIC_BASE_URL: 'http://hub.example',
    });
    expect(issued).toMatchObject({
      status: 'issued',
      link: expect.stringMatching(/^http:\/\/hub.example\/activate#token=/),
    });
    expect((await db.users.getByEmail(address))?.nickname).toBe(address.split('@')[0]);
  });

  it('handles a unique-violation race by re-reading and reissuing, but propagates other failures', async () => {
    const user = await account('super', 'invited');
    const old = await db.accountPasswordLinks.issueInvite(user.id, user.id);
    vi.spyOn(db.users, 'getByEmail').mockResolvedValueOnce(undefined);
    vi.spyOn(db.users, 'create').mockRejectedValueOnce({ code: '23505' });
    const result = await bootstrapFirstAdmin(db, { BOOTSTRAP_ADMIN_EMAIL: user.email });
    expect(result.status).toBe('issued');
    expect(await db.accountPasswordLinks.inspect(old!.token)).toBeNull();
    vi.mocked(db.users.create).mockRejectedValueOnce(new Error('offline'));
    await expect(bootstrapFirstAdmin(db, { BOOTSTRAP_ADMIN_EMAIL: email() })).rejects.toThrow('offline');
  });

  it('rechecks the super role inside the invite lock if the user is demoted', async () => {
    const user = await account('super', 'invited');
    const bind = db.platform.syncLegacyRoleBinding;
    vi.spyOn(db.platform, 'syncLegacyRoleBinding').mockImplementationOnce(async (...args) => {
      await db.users.update(user.id, { role: 'team' });
      await bind(...args);
    });
    expect(await bootstrapFirstAdmin(db, { BOOTSTRAP_ADMIN_EMAIL: user.email })).toEqual({ status: 'changed' });
    expect((await db.accountPasswordLinks.listCurrent()).filter((link) => link.user_id === user.id)).toEqual([]);
  });

  it('exposes only a boolean setup hint and fails closed on lookup failure', async () => {
    const pending = await bootstrapRoutes.request('/');
    expect((await pending.json()).setup_pending).toBe(true);
    expect(pending.headers.get('cache-control')).toBe('no-store');
    await account('super', 'active');
    expect((await (await bootstrapRoutes.request('/')).json()).setup_pending).toBe(false);
    vi.spyOn(db.users, 'hasEstablishedSuper').mockRejectedValue(new Error('offline'));
    expect(await isFirstRunSetupPending(db)).toBe(false);
    expect((await (await bootstrapRoutes.request('/')).json()).setup_pending).toBe(false);
  });
});
