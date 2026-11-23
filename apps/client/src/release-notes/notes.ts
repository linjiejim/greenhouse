/**
 * What's new after an update (jim-uiux 1.7.0 patterns/updates; DESIGN.md States and feedback):
 * the first launch on a newer version says 「已更新到 x · 查看更新内容」 once; a first install and a
 * version whose notes are empty say nothing. React-free rules for ./use-update-notice.ts and
 * ./whats-new-screen.tsx; the notes are the bundle's own CHANGELOG.md (./bundled.ts).
 */
import { unseenReleases, type Release, type ReleaseGroup } from './changelog';

/** The version this device last opened, a pref (src/api/token-storage.ts `loadPref`). */
export const SEEN_PREF = 'releaseNotesSeen';

/**
 * A launch on `current`: remember it when this device has not opened it yet (before telling, so a
 * reload never says it twice), and the releases to announce since the one it last opened. `read`
 * parses the bundled notes only when there is something to compare.
 */
export function launchNotes(
  seen: string | null,
  current: string,
  read: () => Release[],
): { remember: boolean; announce: Release[] } {
  if (seen === current) return { remember: false, announce: [] };
  return { remember: true, announce: seen ? unseenReleases(read(), seen, current) : [] };
}

/**
 * The releases What's new lists, newest first: since `since` (the version this device had before
 * the update, from the notice) up to `current`, else every release; only ones with something to say.
 */
export function shownReleases(releases: Release[], since: string | undefined, current: string | undefined): Release[] {
  const unseen = since && current ? unseenReleases(releases, since, current) : [];
  return unseen.length ? unseen : releases.filter((r) => r.groups.length);
}

/** A release's groups as shown: what the reader has to do (heads-up) always comes first. */
export function shownGroups(release: Release): ReleaseGroup[] {
  return [...release.groups].sort((a, b) => Number(b.kind === 'heads-up') - Number(a.kind === 'heads-up'));
}

const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' };
/** release-please's `**client:** ` before a subject: a code area, which members don't need. */
const SCOPE = /^\*\*[a-z0-9][a-z0-9&;:,._/-]*:\*\*\s+/;

/**
 * An item or summary as the app shows it: without release-please's scope prefix (like the commit
 * and PR links ./changelog.ts drops), with the characters it escapes (`plugins/&lt;id&gt;`). A
 * written lead phrase (`**Settings:** …`, `**更新内容。** …`) stays.
 */
export function shownText(text: string): string {
  return text.replace(SCOPE, '').replace(/&(?:lt|gt|quot|#39|amp);/g, (entity) => ENTITIES[entity] ?? entity);
}
