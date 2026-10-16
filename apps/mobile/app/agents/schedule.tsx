import { readScheduleTime, writeScheduleTime, type ScheduleFrequency } from '../../src/data/schedule-time';
import { repeatOptions } from '../../src/agents/schedule-copy';
import { useLocalSearchParams } from 'expo-router';
import { Section, TextField, Toggle, Picker, Text, DatePicker, useNativeState } from '@expo/ui/swift-ui';
import { disabled, tag, pickerStyle } from '@expo/ui/swift-ui/modifiers';
import { NativeForm, FormLoading, FormNavRow } from '../../src/ui/native-form';
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
          <Section>
            {f.resource.loading ? (
              <FormLoading />
            ) : (
              <FormNavRow label={t('work.loadFailed')} onPress={() => void f.resource.refresh()} />
            )}
          </Section>
        )}
      </NativeForm>
    </>
  );
}
function ScheduleFields({ f }: { f: ReturnType<typeof useSchedule> }) {
  const t = useT();
  const time = readScheduleTime(f.draft.cron);
  const date = new Date(2000, 0, 1, time?.hour ?? 9, time?.minute ?? 0);
  const name = useNativeState(f.draft.name),
    brief = useNativeState(f.draft.brief),
    zone = useNativeState(f.draft.timezone);
  return (
    <>
      <Section modifiers={[disabled(f.saving)]} title={t('integration.name')}>
        <TextField
          text={name}
          maxLength={80}
          placeholder={t('integration.name')}
          onTextChange={(v) => f.change('name', v)}
        />
      </Section>
      <Section modifiers={[disabled(f.saving)]} title={t('integration.brief')}>
        <TextField
          text={brief}
          axis="vertical"
          maxLength={2000}
          placeholder={t('integration.brief')}
          onTextChange={(v) => f.change('brief', v)}
        />
      </Section>
      <Section modifiers={[disabled(f.saving)]} title={t('integration.cron')}>
        <Picker
          label={t('integration.repeat')}
          selection={time?.frequency ?? 'custom'}
          onSelectionChange={(value) => {
            if (value !== 'custom')
              f.change('cron', writeScheduleTime(value as ScheduleFrequency, time?.hour ?? 9, time?.minute ?? 0));
          }}
          modifiers={[pickerStyle('menu')]}
        >
          {repeatOptions(f.draft.cron, t).map((option) => (
            <Text key={option.value} modifiers={[tag(option.value)]}>
              {option.label}
            </Text>
          ))}
        </Picker>
        {time ? (
          <DatePicker
            title={t('integration.cron')}
            selection={date}
            displayedComponents={['hourAndMinute']}
            onDateChange={(value) =>
              f.change('cron', writeScheduleTime(time.frequency, value.getHours(), value.getMinutes()))
            }
          />
        ) : (
          <Text>{t('integration.customScheduleHint')}</Text>
        )}
      </Section>
      <Section modifiers={[disabled(f.saving)]} title={t('integration.timezone')}>
        <TextField
          text={zone}
          maxLength={64}
          placeholder={t('integration.timezone')}
          onTextChange={(v) => f.change('timezone', v)}
        />
      </Section>
      <Section modifiers={[disabled(f.saving)]}>
        <Toggle label={t('integration.quiet')} isOn={f.draft.quiet} onIsOnChange={(v) => f.change('quiet', v)} />
      </Section>
    </>
  );
}
