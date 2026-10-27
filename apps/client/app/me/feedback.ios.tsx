/**
 * 发送反馈 — pushed from 「我」: what happened, in the member's words. The app version, build,
 * station host and the last error it showed go along (src/feedback/use-feedback.ts); Android:
 * ./feedback.android.tsx.
 */

import React from 'react';
import { Section, Text, TextField, useNativeState } from '@expo/ui/swift-ui';
import { lineLimit } from '@expo/ui/swift-ui/modifiers';
import { useFeedback } from '../../src/feedback/use-feedback';
import { useT } from '../../src/lib/i18n';
import { NativeForm } from '../../src/ui/native-form';
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
        <Section footer={<Text>{t('feedback.hint')}</Text>}>
          <TextField
            text={text}
            placeholder={t('feedback.placeholder')}
            onTextChange={feedback.setMessage}
            axis="vertical"
            autoFocus
            modifiers={[lineLimit(10)]}
          />
        </Section>
      </NativeForm>
    </>
  );
}
