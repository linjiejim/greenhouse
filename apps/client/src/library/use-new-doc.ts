/**
 * A new knowledge document (app/doc-new.tsx, SwiftUI; ./doc-new.android.tsx, Material): its
 * title and text, saved into the folder it was made from (or the shelf's top), then opened as its
 * sheet over the shelf.
 */

import { useEffect, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { createDoc } from '../api/knowledge';
import { useT } from '../lib/i18n';
import { useLibraryActions } from './use-library-actions';
import { objectId } from '../lib/object-id';

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

  // close once the new document cleared the discard guard (dirty turns off on the next render)
  useEffect(() => {
    if (!created || closed.current) return;
    closed.current = true;
    router.back();
    setTimeout(() => router.push({ pathname: '/sheet/doc', params: { id: created } }), 0);
  }, [created, router]);

  const save = async () => {
    setSaving(true);
    const doc = await actions.run(
      () => createDoc({ title: title.trim().slice(0, 200), content: body, shelf, folderId }),
      t('library.failed'),
      t('library.docCreated'),
    );
    setSaving(false);
    if (doc) setCreated(String(doc.doc.id));
  };

  return { title, setTitle, body, setBody, saving, save, dirty: !created && !!(title.trim() || body.trim()), canSave: !!title.trim() };
}
