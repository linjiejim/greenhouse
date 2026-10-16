import { useState } from 'react';
import { TimePickerDialog } from '@expo/ui/jetpack-compose';
import { readScheduleTime, writeScheduleTime, type ScheduleFrequency } from '../../src/data/schedule-time';
import { repeatOptions } from '../../src/agents/schedule-copy';
import { useLocalSearchParams } from 'expo-router';
import {
  NativeForm,
  FormLoading,
  FormSection,
  FormSelectRow,
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
            {f.resource.loading ? (
              <FormLoading />
            ) : (
              <FormNavRow label={t('work.loadFailed')} onPress={() => void f.resource.refresh()} />
            )}
          </FormSection>
        )}
      </NativeForm>
    </>
  );
}
function ScheduleFields({ f }: { f: ReturnType<typeof useSchedule> }) {
  const t = useT();
  const time = readScheduleTime(f.draft.cron);
  const date = new Date(2000, 0, 1, time?.hour ?? 9, time?.minute ?? 0);
  const [timeOpen, setTimeOpen] = useState(false);
  const name = useNativeState(f.draft.name),
    brief = useNativeState(f.draft.brief),
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
      <FormSection title={t('integration.cron')}>
        <FormSelectRow
          label={t('integration.repeat')}
          value={time?.frequency ?? 'custom'}
          options={repeatOptions(f.draft.cron, t)}
          onChange={(value) => {
            if (!f.saving && value !== 'custom')
              f.change('cron', writeScheduleTime(value as ScheduleFrequency, time?.hour ?? 9, time?.minute ?? 0));
          }}
        />
        <FormNavRow
          label={time ? t('integration.cron') : t('integration.customSchedule')}
          value={
            time
              ? `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`
              : t('integration.customScheduleHint')
          }
          onPress={() => {
            if (time && !f.saving) setTimeOpen(true);
          }}
        />
        {timeOpen && time ? (
          <TimePickerDialog
            initialDate={date.toISOString()}
            confirmButtonLabel={t('common.save')}
            dismissButtonLabel={t('common.cancel')}
            onDateSelected={(value) => {
              f.change('cron', writeScheduleTime(time.frequency, value.getHours(), value.getMinutes()));
              setTimeOpen(false);
            }}
            onDismissRequest={() => setTimeOpen(false)}
          />
        ) : null}
      </FormSection>
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
