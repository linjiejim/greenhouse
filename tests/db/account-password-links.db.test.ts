import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetProvider,
  hashAccountPasswordToken,
  initDatabase,
  UNSET_ACCOUNT_PASSWORD_HASH,
  type DatabaseProvider,
} from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

let db: DatabaseProvider;

async function invitedUser(label: string) {
  return db.users.create({
    email: `${label}-${crypto.randomUUID()}@test.local`,
    password_hash: UNSET_ACCOUNT_PASSWORD_HASH,
    nickname: label,
    role: 'team',
    status: 'invited',
  });
}

describe('account password links', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('stores only the token hash and atomically activates an invited account', async () => {
    const user = await invitedUser('Invite');
    const issued = await db.accountPasswordLinks.issueInvite(user.id, 'admin-user');

    expect(issued).not.toBeNull();
    expect(issued!.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued!.link.token_hash).not.toContain(issued!.token);
    await expect(db.accountPasswordLinks.inspect(issued!.token)).resolves.toMatchObject({
      user: { id: user.id, status: 'invited' },
      link: { purpose: 'invite' },
    });

    const completed = await db.accountPasswordLinks.complete(issued!.token, 'new-password-hash');
    expect(completed?.user).toMatchObject({
      id: user.id,
      password_hash: 'new-password-hash',
      status: 'active',
      auth_version: 1,
    });
    await expect(db.accountPasswordLinks.inspect(issued!.token)).resolves.toBeNull();
  });

  it('rejects expired links without consuming them', async () => {
    const user = await invitedUser('Expired');
    const issued = await db.accountPasswordLinks.issueInvite(
      user.id,
      'admin-user',
      new Date(Date.now() - 1000).toISOString(),
    );

    await expect(db.accountPasswordLinks.inspect(issued!.token)).resolves.toBeNull();
    await expect(db.accountPasswordLinks.complete(issued!.token, 'new-hash')).resolves.toBeNull();
  });

  it('revokes the previous link when resending', async () => {
    const user = await invitedUser('Resend');
    const first = await db.accountPasswordLinks.issueInvite(user.id, 'admin-one');
    const second = await db.accountPasswordLinks.resend(user.id, 'admin-two');

    expect(second?.link.id).not.toBe(first?.link.id);
    await expect(db.accountPasswordLinks.inspect(first!.token)).resolves.toBeNull();
    await expect(db.accountPasswordLinks.inspect(second!.token)).resolves.toMatchObject({
      link: { id: second!.link.id },
    });
  });

  it('immediately invalidates password and refresh credentials when reset is issued', async () => {
    const user = await db.users.create({
      email: `reset-${crypto.randomUUID()}@test.local`,
      password_hash: 'old-password-hash',
      nickname: 'Reset',
      role: 'team',
    });
    await db.refreshTokens.create(user.id, 'old-refresh-hash', new Date(Date.now() + 60_000).toISOString(), 0);

    const issued = await db.accountPasswordLinks.issueReset(user.id, 'admin-user');
    expect(issued?.user).toMatchObject({
      status: 'reset_required',
      password_hash: UNSET_ACCOUNT_PASSWORD_HASH,
      auth_version: 1,
    });
    expect(issued?.link).toMatchObject({ purpose: 'reset', issued_auth_version: 1 });
    expect(issued?.link.token_hash).toBe(hashAccountPasswordToken(issued!.token));
    await expect(db.accountPasswordLinks.listCurrent()).resolves.toContainEqual(
      expect.objectContaining({ id: issued!.link.id }),
    );
    expect(new Date(issued!.link.expires_at).getTime()).toBeGreaterThan(Date.now());
    await expect(db.refreshTokens.consume('old-refresh-hash')).resolves.toBeNull();
    await expect(db.users.getById(user.id)).resolves.toMatchObject({ status: 'reset_required', auth_version: 1 });
    await expect(db.accountPasswordLinks.inspect(issued!.token)).resolves.toMatchObject({
      user: { status: 'reset_required', auth_version: 1 },
      link: { purpose: 'reset', issued_auth_version: 1 },
    });

    const completed = await db.accountPasswordLinks.complete(issued!.token, 'replacement-hash');
    expect(completed?.user).toMatchObject({ status: 'active', password_hash: 'replacement-hash', auth_version: 2 });
  });

  it('revokes current links when an account is disabled or directly assigned a password', async () => {
    const disabledUser = await invitedUser('Disable');
    const disabledLink = await db.accountPasswordLinks.issueInvite(disabledUser.id, 'admin-user');
    await db.users.updateAndRevokeSessions(disabledUser.id, { status: 'disabled' });
    await expect(db.accountPasswordLinks.inspect(disabledLink!.token)).resolves.toBeNull();

    const directUser = await invitedUser('Direct');
    const directLink = await db.accountPasswordLinks.issueInvite(directUser.id, 'admin-user');
    const updated = await db.users.resetPasswordAndRevokeSessions(directUser.id, 'direct-hash');
    expect(updated).toMatchObject({ status: 'active', password_hash: 'direct-hash', auth_version: 1 });
    await expect(db.accountPasswordLinks.inspect(directLink!.token)).resolves.toBeNull();
  });
});
