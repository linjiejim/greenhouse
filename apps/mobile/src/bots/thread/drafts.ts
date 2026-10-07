/**
 * The Bots composer's draft — what is typed, quoted and attached in a thread —
 * and the state that holds it (`useThreadDraft`). Drafts survive switching
 * threads (each thread is a fresh screen, `key={c}`): the text, the quotes and
 * the images already uploaded (one still uploading is dropped — its upload may
 * not finish). Memory only, for this app run (D19: nothing private on disk);
 * cleared with the account or station, like the Bots store.
 *
 * Images: camera or library, at most `maxImages` per message (the web's Bots
 * composer allows 3), each uploaded as soon as it is picked
 * (`prepareImage` → `uploadImage`, the conversation's path) — Send waits for
 * them (see Composer).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { prepareImage, uploadImage } from '../../api/upload';
import type { ComposerImage } from '../../chat/composer';
import type { Annotation } from '../../chat/model';
import { t } from '../../lib/i18n';
import { useAuth } from '../../store/auth';
import { useStations } from '../../store/stations';
import { alertError, confirmAction } from '../../ui/dialogs';

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
  const images = draft.images.filter((image) => image.status === 'done');
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
  const [images, setImages] = useState<ComposerImage[]>(initial?.images ?? []);
  const [annotations, setAnnotations] = useState<Annotation[]>(initial?.annotations ?? []);
  useEffect(() => saveDraft(sessionId, { text, images, annotations }), [sessionId, text, images, annotations]);

  const addPicked = useCallback(async (assets: ImagePicker.ImagePickerAsset[]) => {
    for (const asset of assets) {
      const id = draftId();
      setImages((arr) => [...arr, { id, uri: asset.uri, status: 'uploading' }]);
      const uri = await prepareImage(asset.uri, asset.width);
      const up = await uploadImage(uri, asset.mimeType || 'image/jpeg');
      setImages((arr) =>
        arr.map((im) =>
          im.id === id
            ? up
              ? { ...im, status: 'done', remote: { id: up.id, url: up.url } }
              : { ...im, status: 'error' }
            : im,
        ),
      );
      if (!up) alertError(t('upload.failed'));
    }
  }, []);

  const imageCount = images.length;
  const attach = useCallback(
    async (from: 'camera' | 'library') => {
      const room = maxImages - imageCount;
      if (room <= 0) {
        alertError(t('chat.maxImages', { n: maxImages }));
        return;
      }
      if (from === 'camera') {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          // The system only asks once — after a "Don't Allow" the way back is Settings.
          const go = await confirmAction({
            title: t('chat.cameraDenied'),
            message: t('chat.cameraDeniedHint'),
            confirmLabel: t('chat.openSettings'),
          });
          if (go) void Linking.openSettings();
          return;
        }
        const res = await ImagePicker.launchCameraAsync({ quality: 0.9 });
        if (!res.canceled) void addPicked(res.assets);
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: room,
        quality: 0.9,
      });
      if (!res.canceled) void addPicked(res.assets.slice(0, room));
    },
    [maxImages, imageCount, addPicked],
  );

  const removeImage = useCallback((id: string) => setImages((arr) => arr.filter((im) => im.id !== id)), []);
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
  }, [sessionId]);
  /** A refused send's draft comes back — unless something new was typed meanwhile. */
  const giveBack = useCallback((draft: Partial<ThreadDraft>) => {
    if (draft.text) setText((cur) => cur || draft.text!);
    if (draft.images?.length) setImages((cur) => (cur.length ? cur : draft.images!));
    if (draft.annotations?.length) setAnnotations((cur) => (cur.length ? cur : draft.annotations!));
  }, []);

  return {
    text,
    setText,
    images,
    annotations,
    attach,
    removeImage,
    removeAnnotation,
    addQuotes,
    take,
    giveBack,
  };
}
