/**
 * A new knowledge document (app/doc-new.tsx, SwiftUI; ./doc-new.android.tsx, Material): its
 * title and text, saved into the folder it was made from (or the shelf's top), then opened as its
 * sheet over the shelf.
 */

import { useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { createDoc } from '../api/knowledge';
import { useT } from '../lib/i18n';
import { useLibraryActions } from './use-library-actions';

export function useNewDoc() {
  const params = useLocalSearchParams<{ shelf?: string; folder?: string }>();
  const shelf = params.shelf === 'personal' ? 'personal' : 'team';
  const folderId = params.folder && /^[0-9]+$/.test(params.folder) ? Number(params.folder) : null;
  const t = useT();
  const router = useRouter();
  const actions = useLibraryActions();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    const doc = await actions.run(
      () => createDoc({ title: title.trim().slice(0, 200), content: body, shelf, folderId }),
      t('library.failed'),
      t('library.docCreated'),
    );
    setSaving(false);
    if (!doc) return;
    router.back();
    setTimeout(() => router.push({ pathname: '/sheet/doc', params: { id: String(doc.doc.id) } }), 0);
  };

  return { title, setTitle, body, setBody, saving, save, dirty: !!(title.trim() || body.trim()), canSave: !!title.trim() };
}
