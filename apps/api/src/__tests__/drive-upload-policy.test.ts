/**
 * Drive upload policy — the server-side gate on what may be uploaded. Pure +
 * unit-tested because it's security-critical: size ceiling, executable/script
 * denylist, and display-name sanitization. The route never trusts the client.
 */

import { describe, it, expect } from 'vitest';
import { validateDriveUpload, safeDriveContentType, MAX_DRIVE_FILE_SIZE } from '../drive/upload-policy.js';

describe('validateDriveUpload', () => {
  it('accepts a normal document under the size limit', () => {
    expect(validateDriveUpload({ name: 'contract.pdf', size: 1024 })).toEqual({ ok: true });
    expect(validateDriveUpload({ name: '装箱单.xlsx', size: 84_000 })).toEqual({ ok: true });
    expect(validateDriveUpload({ name: 'logo.png', size: 320_000 })).toEqual({ ok: true });
  });

  it('rejects files over the 100MB ceiling', () => {
    expect(validateDriveUpload({ name: 'big.zip', size: MAX_DRIVE_FILE_SIZE + 1 }).ok).toBe(false);
    // and accepts right at the limit
    expect(validateDriveUpload({ name: 'big.zip', size: MAX_DRIVE_FILE_SIZE }).ok).toBe(true);
  });

  it('rejects executable / active-content extensions', () => {
    for (const name of ['hack.exe', 'run.sh', 'evil.js', 'page.html', 'icon.svg', 'macro.bat']) {
      expect(validateDriveUpload({ name, size: 10 }).ok).toBe(false);
    }
  });

  it('rejects active-content MIME declarations even with a safe extension', () => {
    for (const content_type of ['text/html; charset=utf-8', 'image/svg+xml', 'APPLICATION/JAVASCRIPT']) {
      expect(validateDriveUpload({ name: 'invoice.txt', size: 10, content_type }).ok).toBe(false);
    }
  });

  it('derives safe storage metadata from the filename rather than client input', () => {
    expect(safeDriveContentType('photo.PNG')).toBe('image/png');
    expect(safeDriveContentType('notes.txt')).toBe('text/plain');
    expect(safeDriveContentType('archive.zip')).toBe('application/octet-stream');
    expect(safeDriveContentType('payload')).toBe('application/octet-stream');
  });

  it('rejects an empty or path-bearing display name', () => {
    expect(validateDriveUpload({ name: '', size: 10 }).ok).toBe(false);
    expect(validateDriveUpload({ name: '   ', size: 10 }).ok).toBe(false);
    expect(validateDriveUpload({ name: '../../etc/passwd', size: 10 }).ok).toBe(false);
    expect(validateDriveUpload({ name: 'a\\b.pdf', size: 10 }).ok).toBe(false);
  });
});
