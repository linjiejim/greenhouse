import { describe, expect, it } from 'vitest';

import { getUpload, isValidUploadId, normalizeKeyPrefix } from './uploads.js';

describe('upload storage boundary', () => {
  it.each([
    '1784639633034-4f8974b9.jpg',
    'gen-1784639629506-b776711a.png',
    '1784639633034-32fd7fa6-01a2-4bdd-9733-737e835da203.webp',
    'gen-1784639629506-32fd7fa6-01a2-4bdd-9733-737e835da203.png',
  ])('accepts server-generated upload ID %s', (id) => {
    expect(isValidUploadId(id)).toBe(true);
  });

  it.each(['1715000000000-deadbeef.jfif', '1715000000000-deadbeef.php'])(
    'keeps legacy flat upload ID %s readable',
    (id) => {
      expect(isValidUploadId(id)).toBe(true);
    },
  );

  it.each([
    '../../.env',
    '/etc/passwd',
    '..\\..\\.env',
    'image.png',
    '1784639633034-nothex.png',
    '1784639633034-32fd7fa6-01a2-4bdd-9733-737e835da203.svg',
    '1784639633034-4f8974b9.jpg?token=x',
  ])('rejects attacker-controlled upload ID %s', async (id) => {
    expect(isValidUploadId(id)).toBe(false);
    await expect(getUpload(id)).rejects.toThrow('Invalid upload ID');
  });
});

describe('object-key prefix from the environment', () => {
  it('falls back when unset or blank', () => {
    expect(normalizeKeyPrefix(undefined, 'X', 'uploads/')).toBe('uploads/');
    expect(normalizeKeyPrefix('   ', 'X', 'uploads/')).toBe('uploads/');
  });

  it.each([
    ['uploads/', 'uploads/'],
    ['uploads', 'uploads/'], // missing trailing slash is a harmless typo — normalise it
    ['  drive/  ', 'drive/'],
    ['drive/crm', 'drive/crm/'],
    ['my-bucket_v2.1/', 'my-bucket_v2.1/'],
  ])('normalises %s to %s', (raw, expected) => {
    expect(normalizeKeyPrefix(raw, 'X', 'uploads/')).toBe(expected);
  });

  // Regression: a .env line that lost its newline glued the NEXT assignment onto this
  // value, producing a real prefix of `uploads/TOKEN_SIGNING_KEY=<hex>`. That filed
  // every chat upload under a junk path for six weeks and printed the swallowed value
  // into the startup log. It must fail at boot, not be accepted silently.
  it.each([
    // Shape of the real incident, with an all-zero stand-in — never paste an actual
    // key-shaped value into a fixture, the secret scanner rightly rejects it.
    `uploads/TOKEN_SIGNING_KEY=${'0'.repeat(64)}`,
    'uploads/ SOME_OTHER=value',
    'uploads/\nTOKEN=abc',
    '../escape/',
    '/absolute/',
  ])('refuses malformed prefix %j', (raw) => {
    expect(() => normalizeKeyPrefix(raw, 'TENCENT_CLOUD_COS_PREFIX', 'uploads/')).toThrow(
      /TENCENT_CLOUD_COS_PREFIX is not a valid object-key prefix/,
    );
  });
});
