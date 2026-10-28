/**
 * A new knowledge document (app/doc-new.tsx, SwiftUI; ./doc-new.android.tsx, Material): its
 * title and text, saved into the folder it was made from (or the shelf's top), then opened as its
 * sheet over the shelf — after the keyboard is down and this sheet has closed (src/shell/close-then.ts).
 */

import { useEffect, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { createDoc } from '../api/knowledge';
import { useT } from '../lib/i18n';
import { useLibraryActions } from './use-library-actions';
import { objectId } from '../lib/object-id';
import { captureIdentity } from '../data/identity';
import { closeThen, keyboardDown } from '../shell/close-then';

export function useNewDoc() {
  const params = useLocalSearchParams<{ shelf?: string; folder?: string }>();
  const shelf = params.shelf === 'personal' ? 'personal' : 'team';
  const folderId = objectId(params.folder);
  const t = useT();
  const router = useRouter();
  const actions = useLibraryActions();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const closed = useRef(false);

  // close once the new document cleared the discard guard (dirty turns off on the next render),
  // then open it: one transition at a time, never the sheet, the keyboard and the next sheet at once
  useEffect(() => {
    if (!created || closed.current) return;
    closed.current = true;
    const current = captureIdentity();
    void closeThen(
      () => router.back(),
      () => {
        if (current()) router.push({ pathname: '/sheet/doc', params: { id: created } });
      },
    );
  }, [created, router]);

  const save = async () => {
    setSaving(true);
    // the keyboard goes down while the station saves, not while the sheets move
    void keyboardDown();
    // no success toast: the document opening is the confirmation, and the toast's fade (a Reanimated
    // layout animation in its own window) would run during the sheet transitions
    const doc = await actions.run(
      () => createDoc({ title: title.trim().slice(0, 200), content: body, shelf, folderId }),
      t('library.failed'),
    );
    setSaving(false);
    if (doc) setCreated(String(doc.doc.id));
  };

  return { title, setTitle, body, setBody, saving, save, dirty: !created && !!(title.trim() || body.trim()), canSave: !!title.trim() };
}
