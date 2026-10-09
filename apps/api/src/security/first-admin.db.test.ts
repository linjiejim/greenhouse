/**
 * The first-administrator bootstrap against a real database: what a fresh
 * one-click deploy goes through on its first boots, and the accounts it must
 * never touch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetProvider, initDatabase, UNSET_ACCOUNT_PASSWORD_HASH, type DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { logger } from '@greenhouse/utils/logger';

vi.mock('../email/service.js', () => ({ getSharedMailboxCredentials: () => null, sendFromSharedMailbox: vi.fn() }));
vi.mock('../chat/runs.js', () => ({ chatRunRegistry: { stopForUser: vi.fn() } }));
vi.mock('../ws/connection-manager.js', () => ({ connectionManager: { disconnectUser: vi.fn() } }));
vi.mock('../scheduler/index.js', () => ({ getScheduler: () => null }));
vi.mock('../cloud-agent/index.js', () => ({ getCloudAgentController: () => null }));
vi.mock('../workflow-engine/index.js', () => ({ getWorkflowEngine: () => ({ cancelRunsForUser: vi.fn() }) }));
vi.mock('../bots/computer/index.js', () => ({ purgeUserComputer: vi.fn() }));
vi.mock('../bots/engine/index.js', () => ({ cancelBotTasksForUser: vi.fn() }));

const { bootstrapFirstAdmin, isFirstRunSetupPending } = await import('./first-admin.js');

let db: DatabaseProvider;

function uniqueEmail(label: string): string {
  return `${label}-${crypto.randomUUID()}@first-admin.test`;
}

function tokenOf(link: string): string {
  return decodeURIComponent(link.slice(link.indexOf('token=') + 'token='.length));
}

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  // Tests run with LOG_LEVEL=silent: watch the logger itself, not the console.
  vi.spyOn(logger, 'warn');
  vi.spyOn(logger, 'error');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.close();
  _resetProvider();
});

describe('bootstrapFirstAdmin', () => {
  it('without BOOTSTRAP_ADMIN_EMAIL only explains what to do', async () => {
    const before = await db.users.count();
    await expect(bootstrapFirstAdmin(db, {})).resolves.toEqual({ status: 'unconfigured' });
    expect(await db.users.count()).toBe(before);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('BOOTSTRAP_ADMIN_EMAIL'));
  });

  it('rejects a malformed email without creating anything', async () => {
    const before = await db.users.count();
    await expect(bootstrapFirstAdmin(db, { BOOTSTRAP_ADMIN_EMAIL: 'not-an-email' })).resolves.toEqual({
      status: 'invalid_email',
    });
    expect(await db.users.count()).toBe(before);
  });

  it('creates an invited super admin, logs a working one-time link, and a restart replaces it', async () => {
    const email = uniqueEmail('owner');
    const env = { BOOTSTRAP_ADMIN_EMAIL: email, PUBLIC_BASE_URL: 'https://gh.example.com' };
    expect(await isFirstRunSetupPending(db)).toBe(true);

    const first = await bootstrapFirstAdmin(db, env);
    if (first.status !== 'issued') throw new Error(`expected a link, got ${first.status}`);
    expect(first.link).toMatch(/^https:\/\/gh\.example\.com\/#\/activate\?token=[A-Za-z0-9_-]{43}$/);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(first.link));

    const user = await db.users.getByEmail(email);
    expect(user).toMatchObject({
      role: 'super',
      status: 'invited',
      password_hash: UNSET_ACCOUNT_PASSWORD_HASH,
      nickname: email.slice(0, email.indexOf('@')),
    });
    const superRole = await db.platform.getRoleByCode('default', 'super');
    const bindings = await db.platform.listRoleBindings([superRole!.id]);
    expect(bindings.map((binding) => binding.user_id)).toContain(user!.id);
    await expect(db.accountPasswordLinks.inspect(tokenOf(first.link))).resolves.toMatchObject({
      user: { id: user!.id },
      link: { purpose: 'invite' },
    });
    // Invited is not owned: the login screen keeps explaining the link.
    expect(await isFirstRunSetupPending(db)).toBe(true);

    const second = await bootstrapFirstAdmin(db, env);
    if (second.status !== 'issued') throw new Error(`expected a link, got ${second.status}`);
    expect(second.userId).toBe(user!.id);
    await expect(db.accountPasswordLinks.inspect(tokenOf(first.link))).resolves.toBeNull();
    const completed = await db.accountPasswordLinks.complete(tokenOf(second.link), 'chosen-password-hash');
    expect(completed?.user).toMatchObject({ id: user!.id, role: 'super', status: 'active' });

    // Owned now: the variable is inert and nothing more is logged.
    vi.mocked(logger.warn).mockClear();
    await expect(bootstrapFirstAdmin(db, env)).resolves.toEqual({ status: 'established' });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(await isFirstRunSetupPending(db)).toBe(false);
  });

  it('logs the path when no public base URL is configured', async () => {
    const outcome = await bootstrapFirstAdmin(db, { BOOTSTRAP_ADMIN_EMAIL: uniqueEmail('pathonly') });
    if (outcome.status !== 'issued') throw new Error(`expected a link, got ${outcome.status}`);
    expect(outcome.link).toMatch(/^\/#\/activate\?token=/);
  });

  it('never promotes a team member or revives a disabled admin who owns the email', async () => {
    const member = await db.users.create({
      email: uniqueEmail('member'),
      password_hash: 'member-hash',
      nickname: 'Member',
      role: 'team',
    });
    await expect(bootstrapFirstAdmin(db, { BOOTSTRAP_ADMIN_EMAIL: member.email })).resolves.toEqual({
      status: 'conflict',
    });
    expect(await db.users.getById(member.id)).toMatchObject({ role: 'team', status: 'active' });

    const disabledAdmin = await db.users.create({
      email: uniqueEmail('former'),
      password_hash: 'former-hash',
      nickname: 'Former',
      role: 'super',
      status: 'disabled',
    });
    await expect(bootstrapFirstAdmin(db, { BOOTSTRAP_ADMIN_EMAIL: disabledAdmin.email })).resolves.toEqual({
      status: 'conflict',
    });
    expect(await db.users.getById(disabledAdmin.id)).toMatchObject({ status: 'disabled' });
    expect(await db.accountPasswordLinks.listCurrent()).not.toContainEqual(
      expect.objectContaining({ user_id: disabledAdmin.id }),
    );
  });

  it('leaves an instance with an established admin alone, whatever the variable says', async () => {
    await db.users.create({
      email: uniqueEmail('established'),
      password_hash: 'admin-hash',
      nickname: 'Admin',
      role: 'super',
    });
    const before = await db.users.count();
    await expect(bootstrapFirstAdmin(db, { BOOTSTRAP_ADMIN_EMAIL: uniqueEmail('late') })).resolves.toEqual({
      status: 'established',
    });
    expect(await db.users.count()).toBe(before);
    expect(await isFirstRunSetupPending(db)).toBe(false);
  });
});
