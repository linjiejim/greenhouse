import { useLocalSearchParams } from 'expo-router';
import { Section, Text, TextField, SecureField, useNativeState } from '@expo/ui/swift-ui';
import { disabled, textContentType } from '@expo/ui/swift-ui/modifiers';
import { NativeForm } from '../../src/ui/native-form';
import { FormChrome } from '../../src/ui/sheet-chrome';
import { useAccount } from '../../src/settings/use-account';
import { useT } from '../../src/lib/i18n';

export default function Account() {
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  return <Editor key={mode} password={mode === 'password'} />;
}
function Editor({ password }: { password: boolean }) {
  const t = useT();
  const f = useAccount(password);
  const about = useNativeState(f.draft.about),
    current = useNativeState(''),
    next = useNativeState(''),
    confirm = useNativeState('');
  return (
    <>
      <FormChrome
        protectNavigation
        title={t(password ? 'integration.changePassword' : 'integration.aboutMe')}
        dirty={f.dirty}
        canSave={f.canSave}
        saving={f.saving}
        onSave={() => void f.save()}
      />
      <NativeForm>
        {password ? (
          <Section modifiers={[disabled(f.saving)]} footer={<Text>{t('integration.passwordHint')}</Text>}>
            <SecureField
              text={current}
              placeholder={t('integration.currentPassword')}
              onTextChange={(value) => f.change('current', value)}
              modifiers={[textContentType('password')]}
            />
            <SecureField
              text={next}
              placeholder={t('integration.newPassword')}
              onTextChange={(value) => f.change('next', value)}
              modifiers={[textContentType('newPassword')]}
            />
            <SecureField
              text={confirm}
              placeholder={t('integration.confirmPassword')}
              onTextChange={(value) => f.change('confirm', value)}
              modifiers={[textContentType('newPassword')]}
            />
          </Section>
        ) : (
          <Section modifiers={[disabled(f.saving)]} title={t('integration.aboutMe')}>
            <TextField
              text={about}
              axis="vertical"
              maxLength={4000}
              placeholder={t('integration.aboutMe')}
              onTextChange={(value) => f.change('about', value)}
            />
          </Section>
        )}
      </NativeForm>
    </>
  );
}
