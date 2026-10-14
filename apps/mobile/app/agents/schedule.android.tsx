import { useLocalSearchParams } from 'expo-router';
import {
  NativeForm,
  FormSection,
  FormTextField,
  FormSwitchRow,
  FormNavRow,
  useNativeState,
} from '../../src/ui/native-form.android';
import { FormChrome } from '../../src/ui/sheet-chrome';
import { useSchedule } from '../../src/agents/use-schedule';
import { useT } from '../../src/lib/i18n';

export default function ScheduleEditor() {
  const { id = '', schedule } = useLocalSearchParams<{ id: string; schedule?: string }>();
  return <Editor key={(id ?? '') + ':' + (schedule ?? '')} id={id} schedule={schedule} />;
}
function Editor({ id, schedule }: { id: string; schedule?: string }) {
  const f = useSchedule(id, schedule);
  const t = useT();
  return (
    <>
      <FormChrome
        protectNavigation
        title={t(schedule ? 'integration.schedules' : 'integration.newSchedule')}
        dirty={f.dirty}
        canSave={f.canSave}
        saving={f.saving}
        onSave={() => void f.save()}
      />
      <NativeForm>
        {f.ready ? (
          <ScheduleFields f={f} />
        ) : (
          <FormSection>
            <FormNavRow
              label={t(f.resource.loading ? 'common.loading' : 'work.loadFailed')}
              onPress={() => void f.resource.refresh()}
            />
          </FormSection>
        )}
      </NativeForm>
    </>
  );
}
function ScheduleFields({ f }: { f: ReturnType<typeof useSchedule> }) {
  const t = useT();
  const name = useNativeState(f.draft.name),
    brief = useNativeState(f.draft.brief),
    cron = useNativeState(f.draft.cron),
    zone = useNativeState(f.draft.timezone);
  return (
    <>
      <FormTextField
        enabled={!f.saving}
        label={t('integration.name')}
        state={name}
        onChangeText={(v) => f.change('name', v)}
      />
      <FormTextField
        enabled={!f.saving}
        label={t('integration.brief')}
        state={brief}
        multiline
        onChangeText={(v) => f.change('brief', v)}
      />
      <FormTextField
        enabled={!f.saving}
        label={t('integration.cron')}
        state={cron}
        onChangeText={(v) => f.change('cron', v)}
      />
      <FormTextField
        enabled={!f.saving}
        label={t('integration.timezone')}
        state={zone}
        onChangeText={(v) => f.change('timezone', v)}
      />
      <FormSection>
        <FormSwitchRow
          enabled={!f.saving}
          label={t('integration.quiet')}
          value={f.draft.quiet}
          onValueChange={(v) => f.change('quiet', v)}
        />
      </FormSection>
    </>
  );
}
