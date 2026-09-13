import { describe, expect, it } from 'vitest';

import { attachmentKeyPrefix, isOwnedAttachmentKey } from './attachment-keys.js';

describe('Cloud Agent attachment key ownership', () => {
  const userId = 'user-1';
  const prefix = attachmentKeyPrefix(userId);

  it('accepts only the canonical user/uuid/filename shape', () => {
    expect(isOwnedAttachmentKey(userId, `${prefix}550e8400-e29b-41d4-a716-446655440000/report.pdf`)).toBe(true);
  });

  it.each([
    `${prefix}../user-2/550e8400-e29b-41d4-a716-446655440000/report.pdf`,
    `${prefix}550e8400-e29b-41d4-a716-446655440000/../report.pdf`,
    `${prefix}550e8400-e29b-41d4-a716-446655440000/sub/report.pdf`,
    `${prefix}not-a-uuid/report.pdf`,
    `${prefix}550e8400-e29b-41d4-a716-446655440000/report\\.pdf`,
  ])('rejects non-canonical owned-looking key %s', (key) => {
    expect(isOwnedAttachmentKey(userId, key)).toBe(false);
  });
});
