import { describe, expect, it } from 'vitest';
import { canShareDoc, shareCandidates, sortedShares } from './share-model';

describe('document share panel', () => {
  it('belongs to the owner of a private document', () => {
    expect(canShareDoc({ visibility: 'private', access: 'owner' })).toBe(true);
    expect(canShareDoc({ visibility: 'team', access: 'owner' })).toBe(false);
    expect(canShareDoc({ visibility: 'private', access: 'editor' })).toBe(false);
    expect(canShareDoc({ visibility: 'private', access: undefined })).toBe(false);
    expect(canShareDoc(null)).toBe(false);
  });

  it('lists grants by name and offers only people without one', () => {
    const shares = [
      { target: 'usr_zed', name: 'Zed', role: 'editor' as const },
      { target: 'usr_ann', name: 'Ann', role: 'reader' as const },
    ];
    expect(sortedShares(shares).map((s) => s.name)).toEqual(['Ann', 'Zed']);
    const users = [
      { id: 'usr_zed', nickname: 'Zed' },
      { id: 'usr_cy', nickname: 'Cy' },
      { id: 'usr_bo', nickname: 'Bo' },
    ];
    expect(shareCandidates(users, shares).map((u) => u.id)).toEqual(['usr_bo', 'usr_cy']);
  });
});
