import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDesktopUpdateStore } from '../../stores/desktop-update-store';
import { loadReleaseNotes, parseReleaseNotes, parseReleaseNotesHistory } from './updates';

const validNotes = {
  schemaVersion: 1,
  appVersion: '0.33.0',
  webBundleVersion: '3',
  title: '桌面升级体验优化',
  summary: '升级下载、提醒和更新记录形成完整闭环。',
  changes: ['新版本下载完成后会在侧边栏持续提示'],
  releasedAt: '2026-07-30T00:00:00.000Z',
};

describe('desktop release notes', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('accepts a concise note that matches the signed bundle schema', () => {
    expect(parseReleaseNotes(validNotes)).toEqual(validNotes);
  });

  it('rejects empty or overly long user-facing copy', () => {
    expect(parseReleaseNotes({ ...validNotes, changes: [] })).toBeNull();
    expect(
      parseReleaseNotes({
        ...validNotes,
        title: '更'.repeat(41),
      }),
    ).toBeNull();
  });

  it('filters malformed history entries and keeps valid releases newest first', () => {
    const older = { ...validNotes, appVersion: '0.32.0', webBundleVersion: '2' };
    const newer = { ...validNotes, appVersion: '0.34.0', webBundleVersion: '4' };

    expect(parseReleaseNotesHistory([older, { nope: true }, newer])).toEqual([newer, older]);
    expect(parseReleaseNotesHistory({ releases: [newer] })).toEqual([]);
  });

  it('loads current and historical notes from API-owned public assets for web and desktop', async () => {
    const older = { ...validNotes, appVersion: '0.32.0', webBundleVersion: '2' };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () => (String(input).endsWith('release-notes-history.json') ? [validNotes, older] : validNotes),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await loadReleaseNotes();

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      '/public/release-notes.json',
      '/public/release-notes-history.json',
    ]);
    expect(useDesktopUpdateStore.getState().currentReleaseNotes).toEqual(validNotes);
    expect(useDesktopUpdateStore.getState().releaseNotesHistory).toEqual([validNotes, older]);
  });
});
