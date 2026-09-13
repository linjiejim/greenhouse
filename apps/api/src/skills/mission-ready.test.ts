/**
 * Mission-ready predicate — the ONE verdict shared by the sandbox sync, the
 * catalog listing (`mission_ready`) and mission launch validation. These cases
 * pin the sandbox-safety contract: unattended sandboxes receive only
 * first-party content or clean third-party content a super reviewed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { SkillRow } from '@greenhouse/db';
import { _setFirstPartyGroupsForTests, resetFirstPartyCache } from './first-party.js';
import { isMissionReadySkill, isSlashSelectableSkill } from './mission-ready.js';
import { toSkillSummary } from './center.js';

const base = {
  name: 'pdf-report',
  status: 'active' as const,
  scan_status: 'clean',
  scan_reviewed_by: null as string | null,
};

beforeEach(() => {
  _setFirstPartyGroupsForTests(
    new Map([
      ['acme-image', 'branding'],
      ['acme-checker', 'business'],
    ]),
  );
});

describe('isSlashSelectableSkill', () => {
  it('allows clean active first-party branding and business skills', () => {
    expect(isSlashSelectableSkill({ ...base, name: 'acme-image' })).toBe(true);
    expect(isSlashSelectableSkill({ ...base, name: 'acme-checker' })).toBe(true);
  });

  // Since core/apps retired (2026-08-17) every first-party pack is slash-selectable,
  // so the surviving gap between the two predicates is the reviewed third-party
  // skill: safe to mount in a sandbox, but never in the `/` menu.
  it('keeps reviewed third-party skills out of direct launch', () => {
    expect(isMissionReadySkill({ ...base, scan_reviewed_by: 'u-super' })).toBe(true);
    expect(isSlashSelectableSkill({ ...base, scan_reviewed_by: 'u-super' })).toBe(false);
  });
});

afterEach(() => {
  resetFirstPartyCache();
});

describe('isMissionReadySkill', () => {
  it('clean + super-reviewed third-party skill is ready', () => {
    expect(isMissionReadySkill({ ...base, scan_reviewed_by: 'u-super' })).toBe(true);
  });

  it('clean first-party skill is ready without a review', () => {
    expect(isMissionReadySkill({ ...base, name: 'acme-image' })).toBe(true);
  });

  it('clean but unreviewed third-party skill is NOT ready', () => {
    expect(isMissionReadySkill(base)).toBe(false);
  });

  it('pending / suspicious / blocked verdicts are never ready, even reviewed or first-party', () => {
    for (const scan_status of ['pending', 'suspicious', 'blocked']) {
      expect(isMissionReadySkill({ ...base, scan_status, scan_reviewed_by: 'u-super' })).toBe(false);
      expect(isMissionReadySkill({ ...base, name: 'acme-image', scan_status })).toBe(false);
    }
  });

  it('archived skills are not ready regardless of verdict', () => {
    expect(isMissionReadySkill({ ...base, status: 'archived', scan_reviewed_by: 'u-super' })).toBe(false);
  });
});

describe('toSkillSummary', () => {
  it('carries sandbox readiness, trusted group and slash policy on the wire shape', () => {
    const row: SkillRow = {
      id: 1,
      name: 'pdf-report',
      display_name: 'PDF Report',
      description: 'Render PDFs',
      tags: '[]',
      latest_version: '0.1.0',
      status: 'active',
      owner_user_id: 'u-owner',
      download_count: 0,
      scan_status: 'clean',
      scan_findings: '[]',
      scan_version: '0.1.0',
      scanned_at: '2026-08-12T00:00:00Z',
      scan_reviewed_by: 'u-super',
      scan_reviewed_at: '2026-08-12T00:00:00Z',
      scan_note: null,
      created_at: '2026-08-12T00:00:00Z',
      updated_at: '2026-08-12T00:00:00Z',
    };
    expect(toSkillSummary(row).mission_ready).toBe(true);
    expect(toSkillSummary({ ...row, scan_reviewed_by: null }).mission_ready).toBe(false);
    const branding = toSkillSummary({ ...row, name: 'acme-image', scan_reviewed_by: null });
    expect(branding.source_group).toBe('branding');
    expect(branding.slash_selectable).toBe(true);
    // Third-party (no repository group) stays out of `/` even once reviewed.
    expect(toSkillSummary(row).slash_selectable).toBe(false);
  });
});
