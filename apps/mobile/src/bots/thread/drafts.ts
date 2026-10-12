/**
 * The Bots composer's draft — what is typed, quoted and attached in a thread —
 * and the state that holds it (`useThreadDraft`). Drafts survive switching
 * threads (each thread is a fresh screen, `key={c}`): the text, the quotes and
 * all selected images (an interrupted upload returns with Retry). Memory only, for this app run (D19: nothing private on disk);
 * cleared with the account or station, like the Bots store.
 *
 * Images: camera or library, at most `maxImages` per message (the web's Bots
 * composer allows 3), each uploaded as soon as it is picked
 * (`prepareImage` → `uploadImage`, the conversation's path) — Send waits for
 * them (see Composer).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { recoverDraftImages, type ComposerImage } from '../../chat/composer-images';
import { useComposerImages } from '../../chat/use-composer-images';
import type { Annotation } from '../../chat/model';
import { useAuth } from '../../store/auth';
import { useStations } from '../../store/stations';

export interface ThreadDraft {
  text: string;
  images: ComposerImage[];
  annotations: Annotation[];
}

const drafts = new Map<string, ThreadDraft>();

export function readDraft(sessionId: string): ThreadDraft | null {
  return drafts.get(sessionId) ?? null;
}

/** Keep (or, when empty, forget) a thread's draft. */
export function saveDraft(sessionId: string, draft: ThreadDraft): void {
  const images = recoverDraftImages(draft.images);
  if (!draft.text.trim() && !images.length && !draft.annotations.length) drafts.delete(sessionId);
  else drafts.set(sessionId, { text: draft.text, images, annotations: draft.annotations });
}

export function clearDraft(sessionId: string): void {
  drafts.delete(sessionId);
}

// Per account per station — drop every draft when either changes.
useAuth.subscribe((s, prev) => {
  if ((s.user?.id ?? null) !== (prev.user?.id ?? null)) drafts.clear();
});
useStations.subscribe((s, prev) => {
  if (s.activeId !== prev.activeId) drafts.clear();
});

let seq = 0;
/** A local id for a picked image or a quote. */
export const draftId = (): string => `d${Date.now().toString(36)}-${++seq}`;

export function useThreadDraft(sessionId: string, maxImages: number) {
  const [initial] = useState(() => readDraft(sessionId));
  const [text, setText] = useState(initial?.text ?? '');
  const { images, setImages, attach, removeImage, retryImages } = useComposerImages(maxImages, initial?.images);
  const [annotations, setAnnotations] = useState<Annotation[]>(initial?.annotations ?? []);
  useEffect(() => saveDraft(sessionId, { text, images, annotations }), [sessionId, text, images, annotations]);

  const removeAnnotation = useCallback((id: string) => setAnnotations((a) => a.filter((x) => x.id !== id)), []);
  const addQuotes = useCallback(
    (quotes: string[]) => setAnnotations((a) => [...a, ...quotes.map((q) => ({ id: draftId(), text: q }))]),
    [],
  );

  const latest = useRef({ text, images, annotations });
  latest.current = { text, images, annotations };
  /** Empty the composer for a send; returns what it held (to give back if the send is refused). */
  const take = useCallback((): ThreadDraft => {
    const draft = latest.current;
    setText('');
    setImages([]);
    setAnnotations([]);
    clearDraft(sessionId);
    return draft;
  }, [sessionId, setImages]);
  /** A refused send's draft comes back — unless something new was typed meanwhile. */
  const giveBack = useCallback(
    (draft: Partial<ThreadDraft>) => {
      if (draft.text) setText((cur) => cur || draft.text!);
      if (draft.images?.length) setImages((cur) => (cur.length ? cur : draft.images!));
      if (draft.annotations?.length) setAnnotations((cur) => (cur.length ? cur : draft.annotations!));
    },
    [setImages],
  );

  return {
    text,
    setText,
    images,
    annotations,
    attach,
    removeImage,
    retryImages,
    removeAnnotation,
    addQuotes,
    take,
    giveBack,
  };
}
