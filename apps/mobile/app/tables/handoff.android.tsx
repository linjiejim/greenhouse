import { useLocalSearchParams } from 'expo-router';
import {
  NativeForm,
  FormSection,
  FormSelectRow,
  FormTextField,
  FormNavRow,
  FormValueRow,
  useNativeState,
} from '../../src/ui/native-form.android';
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
        <FormSection footer={t('integration.handoffHint')}>
          {f.agents.data ? (
            f.options.length ? (
              <FormSelectRow
                label={t('integration.agent')}
                value={f.selected}
                options={f.options.map((a) => ({ value: a.id, label: a.name }))}
                onChange={(id) => {
                  if (!f.saving) f.setAgent(id);
                }}
              />
            ) : (
              <FormValueRow label={t('integration.noAgents')} />
            )
          ) : (
            <FormNavRow
              label={t(f.agents.loading ? 'common.loading' : 'work.loadFailed')}
              onPress={() => void f.agents.refresh()}
            />
          )}
        </FormSection>
        <FormTextField
          label={t('integration.brief')}
          state={brief}
          multiline
          enabled={!f.saving}
          onChangeText={f.setBrief}
        />
      </NativeForm>
    </>
  );
}
