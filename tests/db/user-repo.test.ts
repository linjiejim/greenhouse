/**
 * User Repository integration tests.
 *
 * Tests user CRUD operations against a real PostgreSQL database.
 * Requires: PostgreSQL running at localhost:5432 with greenhouse_test database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, _resetProvider } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';

const PG_URL = 'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_test';
let db: DatabaseProvider;

describe('User Repository', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: PG_URL });
    await db.resetSchema();
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('creates a user and retrieves by id', async () => {
    const user = await db.users.create({
      email: 'alice@test.com',
      password_hash: 'hash123',
      nickname: 'Alice',
      role: 'member',
    });

    expect(user.id).toBeTruthy();
    expect(user.email).toBe('alice@test.com');
    expect(user.nickname).toBe('Alice');
    expect(user.role).toBe('member');

    const found = await db.users.getById(user.id);
    expect(found).toBeDefined();
    expect(found!.email).toBe('alice@test.com');
  });

  it('retrieves user by email', async () => {
    await db.users.create({
      email: 'bob@test.com',
      password_hash: 'hash456',
      nickname: 'Bob',
      role: 'admin',
    });

    const found = await db.users.getByEmail('bob@test.com');
    expect(found).toBeDefined();
    expect(found!.nickname).toBe('Bob');
    expect(found!.role).toBe('admin');
  });

  it('returns undefined for non-existent email', async () => {
    const found = await db.users.getByEmail('nobody@test.com');
    expect(found).toBeUndefined();
  });

  it('returns undefined for non-existent id', async () => {
    const found = await db.users.getById('non-existent-uuid');
    expect(found).toBeUndefined();
  });

  it('lists all users', async () => {
    await db.users.create({ email: 'a@test.com', password_hash: 'h', nickname: 'A', role: 'member' });
    await db.users.create({ email: 'b@test.com', password_hash: 'h', nickname: 'B', role: 'admin' });
    await db.users.create({ email: 'c@test.com', password_hash: 'h', nickname: 'C', role: 'super' });

    const users = await db.users.list();
    expect(users.length).toBe(3);
  });

  it('counts users', async () => {
    expect(await db.users.count()).toBe(0);

    await db.users.create({ email: 'a@test.com', password_hash: 'h', nickname: 'A', role: 'member' });
    await db.users.create({ email: 'b@test.com', password_hash: 'h', nickname: 'B', role: 'member' });

    expect(await db.users.count()).toBe(2);
  });

  it('updates user fields', async () => {
    const user = await db.users.create({
      email: 'update@test.com',
      password_hash: 'h',
      nickname: 'Original',
      role: 'member',
    });

    const updated = await db.users.update(user.id, {
      nickname: 'Updated',
      role: 'admin',
    });

    expect(updated).toBeDefined();
    expect(updated!.nickname).toBe('Updated');
    expect(updated!.role).toBe('admin');
  });

  it('updates user notes', async () => {
    const user = await db.users.create({
      email: 'notes@test.com',
      password_hash: 'h',
      nickname: 'Notes',
      role: 'member',
    });

    await db.users.update(user.id, { notes: 'User prefers Chinese responses' });

    const found = await db.users.getById(user.id);
    expect(found!.notes).toBe('User prefers Chinese responses');
  });

  it('updates last login', async () => {
    const user = await db.users.create({
      email: 'login@test.com',
      password_hash: 'h',
      nickname: 'Login',
      role: 'member',
    });

    const before = await db.users.getById(user.id);
    const lastLoginBefore = before!.last_login_at;

    // Wait a bit to ensure different timestamp
    await new Promise((r) => setTimeout(r, 50));
    await db.users.updateLastLogin(user.id);

    const after = await db.users.getById(user.id);
    if (lastLoginBefore) {
      expect(after!.last_login_at).not.toBe(lastLoginBefore);
    } else {
      expect(after!.last_login_at).toBeTruthy();
    }
  });

  it('sets default daily and monthly limits', async () => {
    const user = await db.users.create({
      email: 'limits@test.com',
      password_hash: 'h',
      nickname: 'Limits',
      role: 'member',
    });

    expect(user.daily_message_limit).toBeGreaterThan(0);
    expect(user.monthly_token_limit).toBeGreaterThan(0);
  });

  it('updates user limits', async () => {
    const user = await db.users.create({
      email: 'ulimit@test.com',
      password_hash: 'h',
      nickname: 'ULimit',
      role: 'member',
    });

    await db.users.update(user.id, {
      daily_message_limit: 500,
      monthly_token_limit: 50000000,
    });

    const found = await db.users.getById(user.id);
    expect(found!.daily_message_limit).toBe(500);
    expect(found!.monthly_token_limit).toBe(50000000);
  });
});
