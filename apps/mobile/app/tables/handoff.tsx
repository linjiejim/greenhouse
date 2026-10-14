import { useLocalSearchParams } from 'expo-router';
import { Section, Text, Picker, TextField, useNativeState, ProgressView } from '@expo/ui/swift-ui';
import { disabled, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import { NativeForm, FormNavRow } from '../../src/ui/native-form';
import { FormChrome } from '../../src/ui/sheet-chrome';
import { useRecordHandoff } from '../../src/tables/use-handoff';
import { useT } from '../../src/lib/i18n';

export default function Handoff() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  return <Editor key={id ?? ''} id={id} />;
}
function Editor({ id }: { id: string }) {
  const f = useRecordHandoff(id);
  const brief = useNativeState('');
  const t = useT();
  return (
    <>
      <FormChrome
        protectNavigation
        title={t('integration.handoff')}
        dirty={f.dirty}
        canSave={f.canSave}
        saving={f.saving}
        onSave={() => void f.save()}
        saveLabel={t('integration.startRun')}
      />
      <NativeForm>
        <Section footer={<Text>{t('integration.handoffHint')}</Text>}>
          {f.agents.data ? (
            f.options.length ? (
              <Picker
                label={t('integration.agent')}
                selection={f.selected}
                onSelectionChange={f.setAgent}
                modifiers={[pickerStyle('menu'), disabled(f.saving)]}
              >
                {f.options.map((a) => (
                  <Text key={a.id} modifiers={[tag(a.id)]}>
                    {a.name}
                  </Text>
                ))}
              </Picker>
            ) : (
              <Text>{t('integration.noAgents')}</Text>
            )
          ) : f.agents.loading ? (
            <ProgressView />
          ) : (
            <FormNavRow label={t('work.loadFailed')} onPress={() => void f.agents.refresh()} />
          )}
        </Section>
        <Section title={t('integration.brief')}>
          <TextField
            text={brief}
            axis="vertical"
            maxLength={4000}
            placeholder={t('integration.brief')}
            onTextChange={f.setBrief}
            modifiers={[disabled(f.saving)]}
          />
        </Section>
      </NativeForm>
    </>
  );
}
