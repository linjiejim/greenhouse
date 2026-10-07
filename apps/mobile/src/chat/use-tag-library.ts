/**
 * The behaviour behind the tag library on both platforms (./tag-library.tsx —
 * SwiftUI, ./tag-library.android.tsx — Material); see the view headers for the
 * two modes. Here: the user's tags, the conversation's tags + ownership in
 * assign mode (`access`), and the actions — `toggle` (optimistic, queued via
 * `useTags().toggleSessionTag`; 5-per-conversation limit explained up front),
 * `create` (20-per-user limit; in assign mode the new tag is attached), `edit`
 * (→ /sheets/tag-editor), `remove` (confirmed), `retry`.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import type { SessionTag } from '../shared/greenhouse-types';
import { useTags } from '../store/tags';
import { getSessionTags, MAX_TAGS_PER_SESSION, MAX_TAGS_PER_USER } from '../api/session-tags';
import { useT } from '../lib/i18n';
import { alertError, confirmAction } from '../ui/dialogs';
import { selectionTick } from '../ui/haptics';

/** What we know about the conversation in assign mode. */
export type TagAccess = 'loading' | 'owner' | 'readOnly' | 'failed';

/** What the library shows: a failure, a spinner, a read-only list, or the editable list. */
export type TagLibraryState = 'failed' | 'loading' | 'readOnly' | 'list';

export function useTagLibrary(sessionId?: string) {
  const t = useT();
  const router = useRouter();
  const tags = useTags((s) => s.tags);
  const loaded = useTags((s) => s.loaded);
  const loadFailed = useTags((s) => s.failed);
  const load = useTags((s) => s.load);
  const removeTag = useTags((s) => s.remove);
  const toggleSessionTag = useTags((s) => s.toggleSessionTag);
  const assigned = useTags((s) => (sessionId ? s.sessionTags[sessionId] : undefined));
  const [access, setAccess] = useState<TagAccess>(sessionId ? 'loading' : 'owner');
  const [attempt, setAttempt] = useState(0);

  // Always refresh the library (tags may have changed on the web).
  useEffect(() => {
    void load(true);
  }, [load]);

  // Assign mode: learn the conversation's tags + ownership. The conversation
  // screen usually seeded the tags already; the fetch still tells us who owns it.
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    setAccess('loading');
    void getSessionTags(sessionId).then((r) => {
      if (!alive) return;
      if (!r) {
        setAccess('failed');
        return;
      }
      // never stomp an assignment made (or still being written) since it was seeded
      if (useTags.getState().sessionTags[sessionId] === undefined) useTags.getState().setSessionTags(sessionId, r.tags);
      setAccess(r.isOwner ? 'owner' : 'readOnly');
    });
    return () => {
      alive = false;
    };
  }, [sessionId, attempt]);

  const retry = useCallback(() => {
    void load(true);
    setAttempt((n) => n + 1);
  }, [load]);

  const assignMode = !!sessionId;
  const writable = !assignMode || access === 'owner';
  const canAssign = assignMode && access === 'owner' && assigned !== undefined;

  const state: TagLibraryState =
    access === 'failed' || (writable && !loaded && loadFailed)
      ? 'failed'
      : access === 'loading' || (writable && !loaded) || (assignMode && writable && !canAssign)
        ? 'loading'
        : access === 'readOnly'
          ? 'readOnly'
          : 'list';

  const edit = (tag: SessionTag) => router.push({ pathname: '/sheets/tag-editor', params: { id: String(tag.id) } });

  const create = () => {
    if (tags.length >= MAX_TAGS_PER_USER) {
      alertError(t('tags.limitPerUser', { n: MAX_TAGS_PER_USER }));
      return;
    }
    if (canAssign && sessionId) {
      // the new tag gets attached right away — explain a full conversation first
      if ((useTags.getState().sessionTags[sessionId]?.length ?? 0) >= MAX_TAGS_PER_SESSION) {
        alertError(t('tags.limitPerSession', { n: MAX_TAGS_PER_SESSION }));
        return;
      }
      router.push({ pathname: '/sheets/tag-editor', params: { sessionId } });
      return;
    }
    router.push('/sheets/tag-editor');
  };

  const toggle = async (tag: SessionTag) => {
    if (!sessionId || !canAssign) return;
    const current = useTags.getState().sessionTags[sessionId] ?? [];
    const attaching = !current.some((x) => x.id === tag.id);
    if (attaching && current.length >= MAX_TAGS_PER_SESSION) {
      alertError(t('tags.limitPerSession', { n: MAX_TAGS_PER_SESSION }));
      return;
    }
    selectionTick(); // the ✓ flips now (optimistic); the write follows
    const r = await toggleSessionTag(sessionId, tag);
    if (r === 'limit') alertError(t('tags.limitPerSession', { n: MAX_TAGS_PER_SESSION }));
    else if (r === 'failed') alertError(t('tags.assignFailed'));
  };

  const remove = async (tag: SessionTag) => {
    const ok = await confirmAction({
      title: t('tags.deleteTitle'),
      message: t('tags.deleteHint', { name: tag.name }),
      confirmLabel: t('tags.delete'),
      destructive: true,
    });
    if (!ok) return;
    if (!(await removeTag(tag.id))) alertError(t('tags.deleteFailed'));
  };

  return { tags, assigned, access, state, assignMode, retry, edit, create, toggle, remove };
}
