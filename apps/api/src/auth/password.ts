/**
 * Password hashing — scrypt-based, zero external dependencies.
 *
 * Uses Node.js built-in crypto.scrypt for password hashing.
 * Format: "<salt_hex>:<key_hex>"
 */

import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

const SALT_LENGTH = 32;
const KEY_LENGTH = 64;

/**
 * Hash a plaintext password using scrypt.
 * Returns "salt_hex:key_hex" string suitable for DB storage.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

/**
 * Verify a plaintext password against a stored hash.
 * Uses timing-safe comparison.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [saltHex, keyHex] = storedHash.split(':');
  if (!saltHex || !keyHex) return false;

  const salt = Buffer.from(saltHex, 'hex');
  const expectedKey = Buffer.from(keyHex, 'hex');
  const key = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;

  if (key.length !== expectedKey.length) return false;
  return timingSafeEqual(key, expectedKey);
}
