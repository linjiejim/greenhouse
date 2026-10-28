/**
 * A new knowledge document (`/doc-new?shelf=&folder=`), a sheet with a SwiftUI form: a title and
 * its text (Markdown). ✕ asks before throwing typed text away. Behaviour in
 * src/library/use-new-doc.ts; Android: ./doc-new.android.tsx.
 */

import React from 'react';
import { Section, TextField, useNativeState } from '@expo/ui/swift-ui';
import { lineLimit } from '@expo/ui/swift-ui/modifiers';
import { useT } from '../src/lib/i18n';
import { useNewDoc } from '../src/library/use-new-doc';
import { NativeForm } from '../src/ui/native-form';
import { FormChrome } from '../src/ui/sheet-chrome';

export default function NewDoc() {
  const t = useT();
  const titleState = useNativeState('');
  const bodyState = useNativeState('');
  const doc = useNewDoc({ title: () => titleState.get(), body: () => bodyState.get() });
  return (
    <>
      <FormChrome
        title={t('library.newDoc')}
        dirty={doc.dirty}
        canSave={doc.canSave}
        saving={doc.saving}
        onSave={() => void doc.save()}
        saveLabel={t('library.create')}
        protectNavigation
      />
      <NativeForm>
        <Section>
          <TextField text={titleState} placeholder={t('library.docTitle')} onTextChange={doc.setTitle} />
        </Section>
        <Section>
          <TextField
            text={bodyState}
            placeholder={t('library.docBody')}
            onTextChange={doc.setBody}
            axis="vertical"
            modifiers={[lineLimit(8)]}
          />
        </Section>
      </NativeForm>
    </>
  );
}
