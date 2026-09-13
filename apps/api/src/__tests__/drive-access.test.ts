/**
 * Drive access resolution — the single source of truth for who can touch a drive
 * node, shared by every /api/drive route so the paths can't diverge (the KB module
 * learned this the hard way — a divergence was a cross-user leak).
 *
 * Pure function: the route resolves the Tables Base role and passes it in, so
 * this stays trivially testable with no DB.
 */

import { describe, it, expect } from 'vitest';
import { resolveDriveAccess, canReadDrive, canWriteDrive } from '../drive-access.js';

describe('resolveDriveAccess — kb scope', () => {
  const ctx = {};

  it('gives the owner of a private node owner access', () => {
    expect(resolveDriveAccess({ scope: 'kb', visibility: 'private', owner_user_id: 'alice' }, 'alice', ctx)).toBe(
      'owner',
    );
  });

  it('treats team nodes as collaborative (any internal user is an editor)', () => {
    expect(resolveDriveAccess({ scope: 'kb', visibility: 'team', owner_user_id: 'bob' }, 'alice', ctx)).toBe('editor');
  });

  it("denies another user's private node (folder sharing is deferred to a later phase)", () => {
    expect(resolveDriveAccess({ scope: 'kb', visibility: 'private', owner_user_id: 'bob' }, 'alice', ctx)).toBeNull();
  });
});

describe('resolveDriveAccess — tables scope', () => {
  it('maps Base roles to Drive access and denies missing membership', () => {
    expect(
      resolveDriveAccess({ scope: 'tables', base_id: 1 }, 'owner', {
        tablesRole: 'owner',
      }),
    ).toBe('owner');
    expect(
      resolveDriveAccess({ scope: 'tables', base_id: 1 }, 'builder', {
        tablesRole: 'builder',
      }),
    ).toBe('editor');
    expect(
      resolveDriveAccess({ scope: 'tables', base_id: 1 }, 'viewer', {
        tablesRole: 'viewer',
      }),
    ).toBe('reader');
    expect(
      resolveDriveAccess({ scope: 'tables', base_id: 1 }, 'outsider', {
        tablesRole: null,
      }),
    ).toBeNull();
  });
});

describe('canReadDrive / canWriteDrive', () => {
  it('read allows any non-null access; write needs owner or editor', () => {
    expect(canReadDrive('reader')).toBe(true);
    expect(canReadDrive(null)).toBe(false);
    expect(canWriteDrive('editor')).toBe(true);
    expect(canWriteDrive('owner')).toBe(true);
    expect(canWriteDrive('reader')).toBe(false);
    expect(canWriteDrive(null)).toBe(false);
  });
});
