/** 发送反馈 on Android (Material form; iOS: ./feedback.tsx, behaviour in src/feedback/use-feedback.ts). */

import React from 'react';
import { useFeedback } from '../../src/feedback/use-feedback';
import { useT } from '../../src/lib/i18n';
import { FormFields, FormSection, FormTextField, NativeForm, useNativeState } from '../../src/ui/native-form.android';
import { FormChrome } from '../../src/ui/sheet-chrome';

export default function Feedback() {
  const t = useT();
  const feedback = useFeedback();
  const text = useNativeState('');
  return (
    <>
      <FormChrome
        title={t('feedback.title')}
        dirty={feedback.dirty}
        canSave={feedback.canSave}
        saving={feedback.saving}
        onSave={() => void feedback.save()}
        saveLabel={t('feedback.send')}
        protectNavigation
      />
      <NativeForm>
        <FormSection footer={t('feedback.hint')}>
          <FormFields>
            <FormTextField label={t('feedback.placeholder')} state={text} onChangeText={feedback.setMessage} multiline />
          </FormFields>
        </FormSection>
      </NativeForm>
    </>
  );
}
