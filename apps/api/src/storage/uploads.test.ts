import { describe, it, expect } from 'vitest';
import { makeExpiringId, expiryOf, isExpired, isInlineId, contentTypeForId } from './uploads.js';

describe('expiring ids', () => {
  it('mints ids of the form exp_<epochSec>_<uuid8>.<ext>', () => {
    const id = makeExpiringId('xlsx', 1000, 5000);
    expect(id).toMatch(/^exp_\d+_[0-9a-f]{8}\.xlsx$/);
  });

  it('normalizes a leading-dot extension and lowercases it', () => {
    expect(makeExpiringId('.CSV', 1000, 0)).toMatch(/\.csv$/);
  });

  it('round-trips the deadline through expiryOf (seconds precision)', () => {
    const now = 5000;
    const id = makeExpiringId('csv', 1000, now); // floor((5000+1000)/1000)*1000 = 6000
    expect(expiryOf(id)).toBe(6000);
  });

  it('returns null for ids without an expiry marker', () => {
    expect(expiryOf('gen-123-abcdef12.png')).toBeNull();
    expect(expiryOf('1715-abcd.jpg')).toBeNull();
  });

  it('isExpired is true only past the deadline, and never for plain ids', () => {
    const id = makeExpiringId('csv', 1000, 5000); // deadline 6000ms
    expect(isExpired(id, 5999)).toBe(false);
    expect(isExpired(id, 6001)).toBe(true);
    expect(isExpired('gen-123-abcdef12.png', 9_999_999_999)).toBe(false);
  });
});

describe('content types & disposition', () => {
  it('maps export extensions to their MIME types', () => {
    expect(contentTypeForId('exp_1_abcdef12.csv')).toBe('text/csv; charset=utf-8');
    expect(contentTypeForId('exp_1_abcdef12.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(contentTypeForId('x.png')).toBe('image/png');
    expect(contentTypeForId('x.bin')).toBe('application/octet-stream');
  });

  it('treats images and pdf as inline, exports as attachments', () => {
    expect(isInlineId('x.png')).toBe(true);
    expect(isInlineId('x.pdf')).toBe(true);
    expect(isInlineId('exp_1_abcdef12.csv')).toBe(false);
    expect(isInlineId('exp_1_abcdef12.xlsx')).toBe(false);
  });
});
