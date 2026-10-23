/**
 * Offline reading of knowledge documents: each opened document's saved copy and the recently
 * opened list, per station + member in the documents directory (../data/disk-cache.ts; they go
 * with sign-out and station removal). Pure rules in ../data/recent-docs.ts.
 */

import { readCache, writeCache, removeCache } from '../data/disk-cache';
import { dropped, parseRecent, parseSaved, toSaved, withOpened, type RecentDoc, type SavedDoc } from '../data/recent-docs';
import type { KbDoc } from '../shared/greenhouse-types';
import { useAuth } from './auth';
import { useStations } from './stations';

const RECENT = 'kb-recent';
const docKind = (id: number) => `kb-doc-${id}`;

function who(): { station: string; member: string } | null {
  const station = useStations.getState().activeId;
  const member = useAuth.getState().user?.id;
  return station && member ? { station, member } : null;
}

export async function recentDocs(): Promise<RecentDoc[]> {
  const id = who();
  return id ? parseRecent(await readCache(id.station, id.member, RECENT)) : [];
}

export async function savedDoc(docId: number): Promise<SavedDoc | null> {
  const id = who();
  return id ? parseSaved(await readCache(id.station, id.member, docKind(docId)), docId) : null;
}

/** A document was read from the server: keep its copy and put it at the top of the recent list. */
export async function rememberDoc(doc: KbDoc): Promise<void> {
  const id = who();
  if (!id) return;
  const before = parseRecent(await readCache(id.station, id.member, RECENT));
  const after = withOpened(before, doc, Date.now());
  writeCache(id.station, id.member, docKind(doc.id), toSaved(doc, Date.now()));
  writeCache(id.station, id.member, RECENT, after);
  for (const gone of dropped(before, after)) removeCache(id.station, id.member, docKind(gone));
}

/** The server says the document is gone or no longer readable: its copy goes too. */
export async function forgetDoc(docId: number): Promise<void> {
  const id = who();
  if (!id) return;
  removeCache(id.station, id.member, docKind(docId));
  const before = parseRecent(await readCache(id.station, id.member, RECENT));
  writeCache(
    id.station,
    id.member,
    RECENT,
    before.filter((entry) => entry.id !== docId),
  );
}
