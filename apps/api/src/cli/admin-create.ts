/**
 * CLI: Create initial super admin user.
 *
 * Usage: pnpm admin:create
 *
 * Prompts for email, password, nickname and creates a super admin.
 * Can also be used non-interactively:
 *   pnpm admin:create --email admin@example.com --password secret123 --nickname Admin
 */

import { createInterface } from 'node:readline';
import { config } from 'dotenv';
import { ENV_FILE } from '../paths.js';

config({ path: ENV_FILE });

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse';
import { initDatabase } from '@greenhouse/db';
import { hashPassword } from '../auth/password.js';
import { PRODUCT_NAME } from '@greenhouse/utils/brand';

const rl = createInterface({ input: process.stdin, output: process.stdout });

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

async function main() {
  const db = await initDatabase({ type: 'pg', pgConnectionString: DATABASE_URL });

  // Parse CLI args
  const args = process.argv.slice(2);
  let email = '';
  let password = '';
  let nickname = '';

  for (let i = 0; i < args.length; i += 2) {
    switch (args[i]) {
      case '--email':
        email = args[i + 1] ?? '';
        break;
      case '--password':
        password = args[i + 1] ?? '';
        break;
      case '--nickname':
        nickname = args[i + 1] ?? '';
        break;
    }
  }

  console.log(`\n🌱 ${PRODUCT_NAME} — Create Super Admin\n`);

  // Check existing super admins
  const users = await db.users.list();
  const superAdmins = users.filter((u) => u.role === 'super');
  if (superAdmins.length > 0) {
    console.log(`⚠️  Warning: ${superAdmins.length} super admin(s) already exist:`);
    for (const u of superAdmins) {
      console.log(`   - ${u.email} (${u.nickname})`);
    }
    console.log('');
  }

  // Interactive prompts if args not provided
  if (!email) {
    email = await question('Email: ');
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('❌ Invalid email format');
    process.exit(1);
  }

  // Check duplicate
  const existing = await db.users.getByEmail(email);
  if (existing) {
    console.error(`❌ A user with email "${email}" already exists`);
    process.exit(1);
  }

  if (!nickname) {
    nickname = await question('Nickname: ');
  }
  if (!nickname.trim()) {
    console.error('❌ Nickname is required');
    process.exit(1);
  }

  if (!password) {
    password = await question('Password (min 8 chars): ');
  }
  if (password.length < 8) {
    console.error('❌ Password must be at least 8 characters');
    process.exit(1);
  }

  // Create user
  const password_hash = await hashPassword(password);
  const user = await db.users.create({
    email,
    password_hash,
    nickname: nickname.trim(),
    role: 'super',
  });

  console.log(`\n✅ Super admin created successfully!`);
  console.log(`   ID:       ${user.id}`);
  console.log(`   Email:    ${user.email}`);
  console.log(`   Nickname: ${user.nickname}`);
  console.log(`   Role:     ${user.role}`);
  console.log(`\nYou can now log in at the web UI with these credentials.\n`);

  rl.close();
  await db.close();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
