#!/usr/bin/env node
/**
 * Generate the ed25519 keypair that signs web-bundle hot updates.
 *
 * Run once. Rotating the key invalidates every published manifest, so a rotation has
 * to ship alongside a new shell release — installed apps only trust the key baked
 * into their binary.
 *
 *   node scripts/desktop/gen-web-bundle-key.mjs
 *
 * Writes:
 *   apps/desktop/.keys/web-bundle-sign.pem  private — git-ignored, NEVER commit
 *   apps/desktop/.keys/web-bundle-sign.pub  public  — base64 raw 32 bytes, baked in
 */

import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const keyDir = resolve(repoRoot, 'apps/desktop/.keys');
const privatePath = resolve(keyDir, 'web-bundle-sign.pem');
const publicPath = resolve(keyDir, 'web-bundle-sign.pub');

if (existsSync(privatePath) && !process.argv.includes('--force')) {
  console.error(`Refusing to overwrite ${privatePath}.`);
  console.error('A new key invalidates every published manifest. Pass --force if that is what you want.');
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');

// Raw 32-byte public key. The JWK `x` field is base64url; Rust's verifier wants
// standard base64, so re-encode rather than hand-editing the alphabet.
const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
if (raw.length !== 32) throw new Error(`unexpected ed25519 key length: ${raw.length}`);

mkdirSync(keyDir, { recursive: true });
writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
writeFileSync(publicPath, `${raw.toString('base64')}\n`);

console.log(`Private key → ${privatePath}  (git-ignored, keep secret)`);
console.log(`Public key  → ${publicPath}`);
console.log(`\nPublic key (baked into the shell at build time):\n  ${raw.toString('base64')}`);
console.log('\nFor CI, set the secret WEB_BUNDLE_SIGN_KEY to the');
console.log('full contents of the .pem file.');
