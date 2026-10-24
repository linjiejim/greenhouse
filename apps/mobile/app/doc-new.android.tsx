/** A new knowledge document on Android (Material form; iOS: ./doc-new.tsx, behaviour in src/library/use-new-doc.ts). */

import React from 'react';
import { useT } from '../src/lib/i18n';
import { useNewDoc } from '../src/library/use-new-doc';
import { FormFields, FormSection, FormTextField, NativeForm, useNativeState } from '../src/ui/native-form.android';
import { FormChrome } from '../src/ui/sheet-chrome';

export default function NewDoc() {
  const t = useT();
  const doc = useNewDoc();
  const titleState = useNativeState('');
  const bodyState = useNativeState('');
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
        <FormSection>
          <FormFields>
            <FormTextField label={t('library.docTitle')} state={titleState} onChangeText={doc.setTitle} />
            <FormTextField label={t('library.docBody')} state={bodyState} onChangeText={doc.setBody} multiline />
          </FormFields>
        </FormSection>
      </NativeForm>
    </>
  );
}
