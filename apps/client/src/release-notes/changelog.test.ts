/** Release notes: the CHANGELOG reads the same in the app as jim-uiux's template says, this repo's own one included. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { compareVersions, parseChangelog, unseenReleases, type Release } from './changelog';
import { launchNotes, shownGroups, shownReleases, shownText } from './notes';

const APP = resolve(__dirname, '../..');
const own = parseChangelog(readFileSync(resolve(APP, '../../CHANGELOG.md'), 'utf8'));
const appVersion: string = JSON.parse(readFileSync(resolve(APP, 'app.json'), 'utf8')).expo.version;

const template = `# 更新记录

## 0.8.0 · 2026-11-23

项目栏更简洁，更新后能看到改了什么。

### 新增

- **更新内容。** 更新后第一次打开，右上角会说更新到了哪一版，点「查看更新内容」看这一版改了什么。
  设置里也能随时看。

### 注意

- 「自动获取」默认关掉了，要用的话到 **设置 › 更新** 打开。

### 修复

- 关窗后再打开，窗口回到原来的位置。 ([#12](https://github.com/o/r/pull/12))

## 0.7.6 · 2026-11-20

- 项目栏去掉标题，「添加」收进一个加号下拉。

## 0.7.5 · 2026-11-19

### Notes

---

更早的版本见 GitHub Releases。
`;

describe('parseChangelog', () => {
  it('reads versions, dates, the summary, groups and items', () => {
    const [latest, mid, old] = parseChangelog(template);
    expect(latest).toMatchObject({
      version: '0.8.0',
      date: '2026-11-23',
      summary: '项目栏更简洁，更新后能看到改了什么。',
    });
    expect(latest!.groups.map((g) => [g.kind, g.title, g.items.length])).toEqual([
      ['new', '新增', 1],
      ['heads-up', '注意', 1],
      ['fixed', '修复', 1],
    ]);
    // a continuation line joins its item; a trailing PR link is dropped
    expect(latest!.groups[0]!.items[0]).toMatch(/看这一版改了什么。 设置里也能随时看。$/);
    expect(latest!.groups[2]!.items[0]).toBe('关窗后再打开，窗口回到原来的位置。');
    // items before any ### are one untitled group
    expect(mid!.groups).toEqual([{ kind: 'other', title: '', items: ['项目栏去掉标题，「添加」收进一个加号下拉。'] }]);
    // a version with nothing to say keeps its place but no groups; prose after a heading is the file's
    expect(old).toMatchObject({ version: '0.7.5', groups: [] });
    expect(old!.summary).toBeUndefined();
  });

  it('reads release-please and Keep a Changelog headings', () => {
    const md = `# Changelog

## [4.2.0](https://github.com/linjiejim/greenhouse/compare/v4.1.0...v4.2.0) (2026-11-05)


### ⚠ BREAKING CHANGES

* **api:** GET /api/platform/apps returns 404.

### Added

* plugin media seams and the asset library plugin ([#105](https://github.com/linjiejim/greenhouse/issues/105)) ([1aaa8f5](https://github.com/linjiejim/greenhouse/commit/1aaa8f5e))

## [Unreleased]

## 4.0.0-rc.1 (2026-10-27)

### Fixed

* x
`;
    const releases = parseChangelog(md);
    expect(releases.map((r) => [r.version, r.date])).toEqual([
      ['4.2.0', '2026-11-05'],
      ['4.0.0-rc.1', '2026-10-27'],
    ]);
    expect(releases[0]!.groups.map((g) => [g.kind, g.title])).toEqual([
      ['heads-up', 'BREAKING CHANGES'],
      ['new', 'Added'],
    ]);
    expect(releases[0]!.groups[1]!.items).toEqual(['plugin media seams and the asset library plugin']);
  });
});

describe("this repository's CHANGELOG.md (what the client bundles)", () => {
  it('reads every release, newest first', () => {
    expect(own.length).toBeGreaterThan(20);
    expect(own.map((r) => r.version)).toEqual([...own.map((r) => r.version)].sort((a, b) => compareVersions(b, a)));
    expect(own.find((r) => r.version === '4.4.0')).toMatchObject({ date: '2026-11-08' });
  });

  it("has a section for the client's own version (the Release PR writes both)", () => {
    expect(own.map((r) => r.version)).toContain(appVersion);
  });

  it('keeps commit and PR links out of the items', () => {
    const items = own.flatMap((r) => r.groups.flatMap((g) => g.items));
    expect(items.length).toBeGreaterThan(100);
    expect(
      items.filter((item) => /\]\(https:\/\/github\.com\/[^)]*\/(commit|issues|pull)\/[^)]*\)\)?$/.test(item)),
    ).toEqual([]);
  });

  it('puts the 4.0 breaking changes in a heads-up group', () => {
    const rc = own.find((r) => r.version === '4.0.0-rc.2')!;
    expect(rc.groups[0]).toMatchObject({ kind: 'heads-up', title: 'BREAKING CHANGES' });
    // the 4.0 upgrade note is prose, which belongs to the file
    expect(own.find((r) => r.version === '4.0.0-rc.1')!.groups.map((g) => g.title)).not.toContain('Upgrading from 3.x');
  });
});

describe('versions', () => {
  it('compares by SemVer precedence', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0-rc.2', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-rc.10', '1.0.0-rc.2')).toBe(1);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
  });

  it('unseen: what came after the last version seen, up to this one, with something to say', () => {
    expect(unseenReleases(own, '4.3.0', '4.4.0').map((r) => r.version)).toEqual(['4.4.0', '4.3.1']);
    // a skipped candidate run is listed too; a store build drops the suffix (app.config.js)
    expect(unseenReleases(own, '3.0.2', '4.0.0').map((r) => r.version)).toEqual(['4.0.0', '4.0.0-rc.2', '4.0.0-rc.1']);
    expect(unseenReleases(own, '4.4.0', '4.4.0')).toEqual([]);
    // a first install, a downgrade, junk in storage: nothing to catch up on
    expect(unseenReleases(own, null, '4.4.0')).toEqual([]);
    expect(unseenReleases(own, '4.4.0', '4.3.1')).toEqual([]);
    expect(unseenReleases(own, 'garbage', '4.4.0')).toEqual([]);
    // a version without notes says nothing
    expect(unseenReleases(parseChangelog(template), '0.7.4', '0.7.5')).toEqual([]);
  });
});

describe('launchNotes', () => {
  const releases = () => own;

  it('says nothing and reads nothing on the version this device already opened', () => {
    const read = vi.fn(releases);
    expect(launchNotes('4.4.0', '4.4.0', read)).toEqual({ remember: false, announce: [] });
    expect(read).not.toHaveBeenCalled();
  });

  it('remembers a first install without announcing it', () => {
    expect(launchNotes(null, '4.4.0', releases)).toEqual({ remember: true, announce: [] });
  });

  it('announces every release since the last one opened, and remembers the new one', () => {
    const launch = launchNotes('4.3.0', '4.4.0', releases);
    expect(launch.remember).toBe(true);
    expect(launch.announce.map((r) => r.version)).toEqual(['4.4.0', '4.3.1']);
  });

  it('remembers a downgrade quietly', () => {
    expect(launchNotes('4.4.0', '4.3.1', releases)).toEqual({ remember: true, announce: [] });
  });
});

describe('shown notes', () => {
  it('lists the releases since the one this device had, else all of them', () => {
    expect(shownReleases(own, '4.3.0', '4.4.0').map((r) => r.version)).toEqual(['4.4.0', '4.3.1']);
    // opened from Settings, or a link whose version says nothing: every release with notes
    expect(shownReleases(own, undefined, '4.4.0')).toHaveLength(own.length);
    expect(shownReleases(own, '4.4.0', '4.4.0')).toHaveLength(own.length);
    expect(shownReleases(parseChangelog(template), undefined, '0.8.0').map((r) => r.version)).toEqual([
      '0.8.0',
      '0.7.6',
    ]);
  });

  it('puts what the reader has to do first', () => {
    const [latest] = parseChangelog(template) as [Release];
    expect(shownGroups(latest).map((g) => g.kind)).toEqual(['heads-up', 'new', 'fixed']);
    expect(latest.groups.map((g) => g.kind)).toEqual(['new', 'heads-up', 'fixed']);
  });

  it("drops release-please's scope and shows the characters it escapes", () => {
    expect(shownText('**plugin-host:** plugins/&lt;id&gt;/ui-src &amp; more')).toBe('plugins/<id>/ui-src & more');
    expect(shownText('**api&web:skills:** add Skill Center')).toBe('add Skill Center');
    expect(shownText('a &copy; b')).toBe('a &copy; b');
    // a lead phrase someone wrote stays
    expect(shownText('**Settings:** text size follows the account')).toBe(
      '**Settings:** text size follows the account',
    );
    expect(shownText('**更新内容。** 更新后第一次打开')).toBe('**更新内容。** 更新后第一次打开');
    expect(shownText('kit **defineExtension** is removed')).toBe('kit **defineExtension** is removed');
  });
});
