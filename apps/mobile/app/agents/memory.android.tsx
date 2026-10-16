import { useLocalSearchParams } from 'expo-router';
import {
  NativeForm,
  FormLoading,
  FormActionRow,
  FormSection,
  FormTextField,
  useNativeState,
} from '../../src/ui/native-form.android';
import { FormChrome } from '../../src/ui/sheet-chrome';
import { useMemory } from '../../src/agents/use-memory';
import { useT } from '../../src/lib/i18n';

export default function MemoryEditor() {
  const { id = '', memory } = useLocalSearchParams<{ id: string; memory?: string }>();
  return <Editor key={id + ':' + (memory ?? '')} id={id} memory={memory} />;
}
function Editor({ id, memory }: { id: string; memory?: string }) {
  const f = useMemory(id, memory);
  const t = useT();
  return (
    <>
      <FormChrome
        protectNavigation
        title={t(memory ? 'integration.memories' : 'integration.newMemory')}
        dirty={f.dirty}
        canSave={f.canSave}
        saving={f.saving}
        onSave={() => void f.save()}
      />
      <NativeForm>
        {f.ready ? (
          <Fields f={f} />
        ) : (
          <FormSection>
            {f.r.loading ? (
              <FormLoading />
            ) : (
              <FormActionRow label={t('work.loadFailed')} onPress={() => void f.r.refresh()} />
            )}
          </FormSection>
        )}
      </NativeForm>
    </>
  );
}

function Fields({ f }: { f: ReturnType<typeof useMemory> }) {
  const t = useT();
  const title = useNativeState(f.draft.title);
  const content = useNativeState(f.draft.content);
  return (
    <>
      <FormTextField
        enabled={!f.saving}
        state={title}
        label={t('integration.memoryTitle')}
        onChangeText={(value) => f.change('title', value)}
      />
      <FormTextField
        enabled={!f.saving}
        state={content}
        label={t('integration.memoryContent')}
        multiline
        onChangeText={(value) => f.change('content', value)}
      />
    </>
  );
}
