import { useLocalSearchParams } from 'expo-router';
import { NativeForm, FormSection, FormTextField, useNativeState } from '../../src/ui/native-form.android';
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
          <FormSection footer={t('integration.passwordHint')}>
            <FormTextField
              enabled={!f.saving}
              state={current}
              secure
              label={t('integration.currentPassword')}
              onChangeText={(value) => f.change('current', value)}
            />
            <FormTextField
              enabled={!f.saving}
              state={next}
              secure
              label={t('integration.newPassword')}
              onChangeText={(value) => f.change('next', value)}
            />
            <FormTextField
              enabled={!f.saving}
              state={confirm}
              secure
              label={t('integration.confirmPassword')}
              onChangeText={(value) => f.change('confirm', value)}
            />
          </FormSection>
        ) : (
          <FormSection>
            <FormTextField
              enabled={!f.saving}
              state={about}
              label={t('integration.aboutMe')}
              multiline
              onChangeText={(value) => f.change('about', value)}
            />
          </FormSection>
        )}
      </NativeForm>
    </>
  );
}
