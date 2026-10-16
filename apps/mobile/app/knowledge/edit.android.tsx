import { useLocalSearchParams } from 'expo-router';
import { useEditor } from '../../src/knowledge/use-editor';
import { useT } from '../../src/lib/i18n';
import {
  NativeForm,
  FormFields,
  FormTextField,
  FormValueRow,
  FormSection,
  useNativeState,
} from '../../src/ui/native-form.android';
import { FormChrome, SheetClose } from '../../src/ui/sheet-chrome';
export default function Edit() {
  const { k } = useLocalSearchParams<{ k?: string }>();
  const f = useEditor(k);
  const t = useT();
  return (
    <>
      {f.snapshot ? (
        <FormChrome
          protectNavigation
          title={t('work.edit')}
          dirty={f.dirty}
          canSave={f.dirty && !!f.title.trim() && f.title.length <= 200}
          saving={f.saving}
          onSave={() => void f.save()}
          onReload={() => void f.reload()}
        />
      ) : (
        <SheetClose />
      )}
      <NativeForm>
        {f.snapshot ? (
          <Fields key={f.epoch} f={f} />
        ) : (
          <FormSection>
            <FormValueRow label={t('work.loadFailed')} />
          </FormSection>
        )}
      </NativeForm>
    </>
  );
}

function Fields({ f }: { f: ReturnType<typeof useEditor> }) {
  const t = useT();
  const title = useNativeState(f.title);
  const body = useNativeState(f.body);
  return (
    <FormFields>
      <FormTextField label={t('work.titleField')} state={title} onChangeText={f.setTitle} />
      <FormTextField label={t('work.markdown')} state={body} onChangeText={f.setBody} multiline />
    </FormFields>
  );
}
