/**
 * A new knowledge document (`/doc-new?shelf=&folder=`), a sheet with a SwiftUI form: a title and
 * its text (Markdown). Saved into the folder it was made from (or the shelf's top), then it opens
 * as its sheet. ✕ asks before throwing typed text away. Android: ./doc-new.android.tsx.
 */

import React, { useState } from 'react';
import { Section, TextField, useNativeState } from '@expo/ui/swift-ui';
import { lineLimit } from '@expo/ui/swift-ui/modifiers';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { createDoc } from '../src/api/knowledge';
import { useT } from '../src/lib/i18n';
import { useLibraryActions } from '../src/library/use-library-actions';
import { NativeForm } from '../src/ui/native-form';
import { FormChrome } from '../src/ui/sheet-chrome';

export default function NewDoc() {
  const params = useLocalSearchParams<{ shelf?: string; folder?: string }>();
  const shelf = params.shelf === 'personal' ? 'personal' : 'team';
  const folderId = params.folder && /^[0-9]+$/.test(params.folder) ? Number(params.folder) : null;
  const t = useT();
  const router = useRouter();
  const actions = useLibraryActions();
  const titleState = useNativeState('');
  const bodyState = useNativeState('');
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
    // the new document opens over the shelf it went to
    setTimeout(() => router.push({ pathname: '/sheet/doc', params: { id: String(doc.doc.id) } }), 0);
  };

  return (
    <>
      <FormChrome
        title={t('library.newDoc')}
        dirty={!!(title.trim() || body.trim())}
        canSave={!!title.trim()}
        saving={saving}
        onSave={() => void save()}
        saveLabel={t('library.create')}
        protectNavigation
      />
      <NativeForm>
        <Section>
          <TextField text={titleState} placeholder={t('library.docTitle')} onTextChange={setTitle} />
        </Section>
        <Section>
          <TextField text={bodyState} placeholder={t('library.docBody')} onTextChange={setBody} axis="vertical" modifiers={[lineLimit(8)]} />
        </Section>
      </NativeForm>
    </>
  );
}
