import { describe, expect, it } from 'vitest';
import type { SkillSummary } from '../../lib/api/skills.js';
import {
  classifySkill,
  countNeedsReview,
  countSkillOrigins,
  filterSkills,
  groupSkills,
  needsReview,
} from './grouping.js';

function skill(over: Partial<SkillSummary>): SkillSummary {
  return {
    name: 'x',
    display_name: 'X',
    description: '',
    tags: [],
    latest_version: '1.0.0',
    status: 'active',
    owner_user_id: 'owner-1',
    download_count: 0,
    scan_status: 'clean',
    scan_findings: [],
    scan_version: '1.0.0',
    scanned_at: '2026-01-01T00:00:00Z',
    scan_reviewed_by: null,
    scan_reviewed_at: null,
    scan_note: null,
    mission_ready: false,
    source_group: null,
    slash_selectable: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('classifySkill', () => {
  it('uses the trusted repository group for first-party skills', () => {
    expect(classifySkill(skill({ source_group: 'branding', tags: ['official'] }), 'me')).toBe('branding');
  });
  it('does not trust an owner-editable official tag as a repository group', () => {
    expect(classifySkill(skill({ tags: ['official', 'core'], owner_user_id: 'me' }), 'me')).toBe('mine');
  });
  it('owned by current user & not official → mine', () => {
    expect(classifySkill(skill({ owner_user_id: 'me', tags: ['custom'] }), 'me')).toBe('mine');
  });
  it("someone else's non-official skill → team", () => {
    expect(classifySkill(skill({ owner_user_id: 'other' }), 'me')).toBe('team');
  });
  it('no current user → non-official is team', () => {
    expect(classifySkill(skill({ owner_user_id: 'other' }), undefined)).toBe('team');
  });
});

describe('groupSkills', () => {
  it('returns ordered, non-empty groups', () => {
    const groups = groupSkills(
      [
        skill({ name: 'a', tags: ['official'], source_group: 'branding' }),
        skill({ name: 'b', owner_user_id: 'me' }),
        skill({ name: 'c', owner_user_id: 'other' }),
      ],
      'me',
    );
    expect(groups.map((g) => g.key)).toEqual(['branding', 'team', 'mine']);
    expect(groups.find((g) => g.key === 'mine')?.skills.map((s) => s.name)).toEqual(['b']);
  });
  it('splits first-party skills by repository group', () => {
    const groups = groupSkills(
      [skill({ name: 'brand', source_group: 'branding' }), skill({ name: 'checker', source_group: 'business' })],
      'me',
    );
    expect(groups.map((g) => g.key)).toEqual(['branding', 'business']);
  });
  it('drops empty groups', () => {
    const groups = groupSkills([skill({ source_group: 'branding' })], 'me');
    expect(groups.map((g) => g.key)).toEqual(['branding']);
  });
  it('preserves input order within a group (stable partition)', () => {
    const groups = groupSkills(
      [
        skill({ name: 'm2', owner_user_id: 'me' }),
        skill({ name: 'b1', source_group: 'business' }),
        skill({ name: 'm1', owner_user_id: 'me' }),
        skill({ name: 'b2', source_group: 'business' }),
        skill({ name: 'm3', owner_user_id: 'me' }),
      ],
      'me',
    );
    // Buckets keep the order items were seen in — not sorted by name/version.
    expect(groups.find((g) => g.key === 'mine')?.skills.map((s) => s.name)).toEqual(['m2', 'm1', 'm3']);
    expect(groups.find((g) => g.key === 'business')?.skills.map((s) => s.name)).toEqual(['b1', 'b2']);
  });
});

describe('countSkillOrigins', () => {
  it('keeps the landing counters origin-based while browse groups use repository folders', () => {
    expect(
      countSkillOrigins(
        [
          skill({ source_group: 'business' }),
          skill({ owner_user_id: 'me', tags: ['official', 'core'] }),
          skill({ owner_user_id: 'other' }),
        ],
        'me',
      ),
    ).toEqual({ builtin: 1, team: 1, mine: 1 });
  });
});

describe('needs-review grouping', () => {
  it('quarantined skills lift into a "Needs review" group at the top — for reviewers only', () => {
    const skills = [
      skill({ name: 'a', source_group: 'branding' }),
      skill({ name: 'bad', owner_user_id: 'me', scan_status: 'suspicious' }),
      skill({ name: 'banned', owner_user_id: 'other', scan_status: 'blocked' }),
    ];
    const forSuper = groupSkills(skills, 'me', true);
    expect(forSuper.map((g) => g.key)).toEqual(['review', 'branding']);
    expect(forSuper[0]!.skills.map((s) => s.name)).toEqual(['bad', 'banned']);

    // Without review rights they stay in their origin group — an owner still
    // has to find their own flagged skill in order to fix it.
    const forMember = groupSkills(skills, 'me', false);
    expect(forMember.map((g) => g.key)).toEqual(['branding', 'team', 'mine']);
    expect(forMember.find((g) => g.key === 'mine')?.skills.map((s) => s.name)).toEqual(['bad']);
  });

  it('needsReview covers suspicious and blocked only', () => {
    expect(needsReview(skill({ scan_status: 'suspicious' }))).toBe(true);
    expect(needsReview(skill({ scan_status: 'blocked' }))).toBe(true);
    expect(needsReview(skill({ scan_status: 'clean' }))).toBe(false);
    expect(needsReview(skill({ scan_status: 'pending' }))).toBe(false);
  });

  it('countNeedsReview ignores archived skills and handles a null catalog', () => {
    expect(countNeedsReview(null)).toBe(0);
    expect(
      countNeedsReview([
        skill({ scan_status: 'suspicious' }),
        skill({ scan_status: 'blocked', status: 'archived' }),
        skill({ scan_status: 'clean' }),
      ]),
    ).toBe(1);
  });
});

describe('filterSkills', () => {
  const skills = [
    skill({
      name: 'acme-crm',
      display_name: 'Greenhouse CRM',
      description: 'customer stuff',
      tags: ['official', 'apps'],
    }),
    skill({ name: 'my-notes', display_name: 'Notes', description: 'personal', tags: ['custom'] }),
  ];
  it('empty query returns all', () => {
    expect(filterSkills(skills, '  ')).toHaveLength(2);
  });
  it('matches display_name / name / description / tags case-insensitively', () => {
    expect(filterSkills(skills, 'CRM').map((s) => s.name)).toEqual(['acme-crm']);
    expect(filterSkills(skills, 'customer').map((s) => s.name)).toEqual(['acme-crm']);
    expect(filterSkills(skills, 'apps').map((s) => s.name)).toEqual(['acme-crm']);
    expect(filterSkills(skills, 'notes').map((s) => s.name)).toEqual(['my-notes']);
  });
});
