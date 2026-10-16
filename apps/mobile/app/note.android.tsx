import { useLocalSearchParams } from 'expo-router';
import { useNote } from '../src/conversation/notes/use-note';
import { useT } from '../src/lib/i18n';
import { NativeForm, FormSection, FormValueRow, FormTextField, useNativeState } from '../src/ui/native-form.android';
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
          <FormSection>
            <FormValueRow label={t('work.loadFailed')} />
          </FormSection>
        )}
      </NativeForm>
    </>
  );
}
function Fields({ f }: { f: ReturnType<typeof useNote> }) {
  const body = useNativeState(f.body);
  const t = useT();
  return (
    <FormTextField enabled={!f.saving} state={body} label={t('work.markdown')} multiline onChangeText={f.setBody} />
  );
}
