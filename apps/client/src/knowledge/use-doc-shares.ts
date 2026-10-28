/**
 * A document's share panel, shared by the browser dialog (share-dialog.web.tsx) and the phone
 * sheet (app/doc-share.tsx): the document, who it is shared with and at which access, the people
 * it may still go to, and share / change access / stop sharing. Only the owner of a private
 * document gets here (src/knowledge/share-model.ts); a team document shows why it takes no
 * grants, and a refusal (403) turns the panel into the owner-only note. Every write is bound to
 * the identity that made it, says how it went and reloads the list.
 */

import { useCallback, useMemo, useState } from 'react';
import { getDoc, listDocShares, listShareableUsers, shareDoc, unshareDoc } from '../api/knowledge';
import type { ApiResult } from '../api/client';
import { captureIdentity } from '../data/identity';
import { useResource } from '../data/use-resource';
import { useT, type TranslationKey } from '../lib/i18n';
import type { KbDoc, KbShare } from '../shared/greenhouse-types';
import { alertError, confirmAction } from '../ui/dialogs';
import { toast } from '../ui/toast';
import { canShareDoc, shareCandidates, sortedShares, type ShareRole } from './share-model';

type Loaded = { doc: KbDoc; shares: KbShare[] | null; refused: boolean };

export function useDocShares(docId: string | null) {
  const t = useT();
  const load = useCallback(async (): Promise<ApiResult<Loaded | null>> => {
    if (!docId) return { ok: true, data: null };
    const doc = await getDoc(docId);
    if (!doc.ok) return doc;
    if (!canShareDoc(doc.data.doc)) return { ok: true, data: { doc: doc.data.doc, shares: null, refused: false } };
    const shares = await listDocShares(docId);
    if (!shares.ok && shares.status === 403) return { ok: true, data: { doc: doc.data.doc, shares: null, refused: true } };
    if (!shares.ok) return shares;
    return { ok: true, data: { doc: doc.data.doc, shares: shares.data.shares, refused: false } };
  }, [docId]);
  const data = useResource(load, { unfocused: true });
  const [refused, setRefused] = useState(false);
  const [busy, setBusy] = useState(false);
  const doc = data.data?.doc ?? null;
  const manage = !refused && !data.data?.refused && canShareDoc(doc) && !!data.data?.shares;
  const people = useResource(
    useCallback(
      () => (manage ? listShareableUsers() : Promise.resolve({ ok: true as const, data: { users: [] } })),
      [manage],
    ),
    { unfocused: true },
  );
  const raw = data.data?.shares;
  const shares = useMemo(() => sortedShares(raw ?? []), [raw]);
  const candidates = useMemo(() => shareCandidates(people.data?.users ?? [], shares), [people.data, shares]);
  const { refresh } = data;

  const write = useCallback(
    async (call: () => Promise<ApiResult<unknown>>, failed: TranslationKey, done: string): Promise<boolean> => {
      if (busy || !docId) return false;
      const current = captureIdentity();
      setBusy(true);
      const result = await call();
      if (!current()) return false;
      setBusy(false);
      void refresh();
      if (!result.ok) {
        if (result.status === 403) setRefused(true);
        alertError(t(failed), result.message);
        return false;
      }
      toast(done);
      return true;
    },
    [busy, docId, refresh, t],
  );

  const add = (userId: string, role: ShareRole) => {
    const name = people.data?.users.find((u) => u.id === userId)?.nickname ?? userId;
    return write(() => shareDoc(docId ?? '', [userId], role), 'knowledge.share.failed', t('knowledge.share.shared', { name }));
  };

  // sharing again with someone replaces their access
  const changeRole = (share: KbShare, role: ShareRole) =>
    role === share.role
      ? Promise.resolve(false)
      : write(() => shareDoc(docId ?? '', [share.target], role), 'knowledge.share.failed', t('knowledge.share.roleChanged'));

  const remove = async (share: KbShare) => {
    const current = captureIdentity();
    const sure = await confirmAction({
      title: t('knowledge.share.removeTitle', { name: share.name }),
      message: t('knowledge.share.removeHint'),
      confirmLabel: t('knowledge.share.remove'),
      destructive: true,
    });
    if (!sure || !current()) return false;
    return write(
      () => unshareDoc(docId ?? '', share.target),
      'knowledge.share.removeFailed',
      t('knowledge.share.removed', { name: share.name }),
    );
  };

  return {
    doc,
    shares,
    candidates,
    manage,
    /** Why there is nothing to manage: a team document, or not the owner's to share. */
    note: !doc
      ? null
      : doc.visibility === 'team'
        ? ('teamDoc' as const)
        : refused || data.data?.refused || !canShareDoc(doc)
          ? ('ownerOnly' as const)
          : null,
    /** The station offers no one to pick (conversation sharing off hides that list). */
    noPeople: manage && !!people.error,
    busy,
    loading: data.loading,
    error: data.error,
    refresh,
    add,
    changeRole,
    remove,
  };
}

export type DocShares = ReturnType<typeof useDocShares>;
