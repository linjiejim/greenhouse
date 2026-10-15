import { useLocalSearchParams } from 'expo-router';
import { Section, Text, TextField, useNativeState } from '@expo/ui/swift-ui';
import { disabled } from '@expo/ui/swift-ui/modifiers';
import { useNote } from '../src/conversation/notes/use-note';
import { useT } from '../src/lib/i18n';
import { NativeForm } from '../src/ui/native-form';
import { FormChrome, SheetClose } from '../src/ui/sheet-chrome';

export default function NoteEditor() {
  const { c = '', k } = useLocalSearchParams<{ c: string; k?: string }>();
  return <Editor key={c + ':' + (k ?? '')} conversation={c} handoff={k} />;
}
function Editor({ conversation, handoff }: { conversation: string; handoff?: string }) {
  const f = useNote(conversation, handoff);
  const t = useT();
  return (
    <>
      {f.ready ? (
        <FormChrome
          protectNavigation
          title={t(handoff ? 'integration.editNote' : 'integration.newNote')}
          dirty={f.dirty}
          canSave={f.canSave}
          saving={f.saving}
          onSave={() => void f.save()}
        />
      ) : (
        <SheetClose />
      )}
      <NativeForm>
        {f.ready ? (
          <Fields f={f} />
        ) : (
          <Section>
            <Text>{t('work.loadFailed')}</Text>
          </Section>
        )}
      </NativeForm>
    </>
  );
}
function Fields({ f }: { f: ReturnType<typeof useNote> }) {
  const body = useNativeState(f.body);
  const t = useT();
  return (
    <Section title={t('work.markdown')} modifiers={[disabled(f.saving)]}>
      <TextField
        text={body}
        axis="vertical"
        maxLength={20000}
        placeholder={t('work.markdown')}
        onTextChange={f.setBody}
      />
    </Section>
  );
}
