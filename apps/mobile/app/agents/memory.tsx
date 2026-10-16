import { useLocalSearchParams } from 'expo-router';
import { Section, TextField, useNativeState } from '@expo/ui/swift-ui';
import { disabled } from '@expo/ui/swift-ui/modifiers';
import { NativeForm, FormLoading, FormNavRow } from '../../src/ui/native-form';
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
          <Section>
            {f.r.loading ? (
              <FormLoading />
            ) : (
              <FormNavRow label={t('work.loadFailed')} onPress={() => void f.r.refresh()} />
            )}
          </Section>
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
      <Section title={t('integration.memoryTitle')} modifiers={[disabled(f.saving)]}>
        <TextField
          text={title}
          maxLength={120}
          placeholder={t('integration.memoryTitle')}
          onTextChange={(value) => f.change('title', value)}
        />
      </Section>
      <Section title={t('integration.memoryContent')} modifiers={[disabled(f.saving)]}>
        <TextField
          text={content}
          axis="vertical"
          maxLength={4000}
          placeholder={t('integration.memoryContent')}
          onTextChange={(value) => f.change('content', value)}
        />
      </Section>
    </>
  );
}
