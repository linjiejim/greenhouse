import { useLocalSearchParams } from 'expo-router';
import { Section, TextField, Text, useNativeState } from '@expo/ui/swift-ui';
import { useEditor } from '../../src/knowledge/use-editor';
import { useT } from '../../src/lib/i18n';
import { NativeForm } from '../../src/ui/native-form';
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
          <Section>
            <Text>{t('work.loadFailed')}</Text>
          </Section>
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
    <>
      <Section title={t('work.titleField')}>
        <TextField text={title} maxLength={200} onTextChange={f.setTitle} placeholder={t('work.titleField')} />
      </Section>
      <Section title={t('work.markdown')}>
        <TextField
          text={body}
          axis="vertical"
          maxLength={500000}
          onTextChange={f.setBody}
          placeholder={t('work.markdown')}
        />
      </Section>
    </>
  );
}
