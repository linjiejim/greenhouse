import { Fragment } from 'react';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Section, Text } from '@expo/ui/swift-ui';
import { disabled } from '@expo/ui/swift-ui/modifiers';
import { NativeForm, FormLoading, FormNavRow } from '../../src/ui/native-form';
import { FormChrome, SheetClose } from '../../src/ui/sheet-chrome';
import { FieldEditor } from '../../src/tables/fields';
import { useAppCard } from '../../src/apps/use-card';
import { useAppAction } from '../../src/apps/use-action';
import { appCardPath, choiceCard, recordChoice, canAct } from '../../src/apps/model';
import { openLink } from '../../src/lib/links';
import { getApiBase } from '../../src/store/stations';
import { useT } from '../../src/lib/i18n';

export default function AppCardSheet() {
  const { k = '' } = useLocalSearchParams<{ k: string }>();
  return <Editor key={k ?? ''} k={k} />;
}
function Editor({ k }: { k: string }) {
  const f = useAppCard(k);
  const t = useT();
  const context = f.context;
  return (
    <>
      {context && !context.record ? (
        <FormChrome
          protectNavigation
          title={context.card.title || t('work.form')}
          dirty={f.dirty}
          canSave={f.canSave}
          saving={f.saving}
          onSave={() => void f.save()}
          saveLabel={t('work.submit')}
          onReload={() => void f.reload()}
        />
      ) : (
        <>
          <Stack.Screen options={{ title: context?.card.title ?? t('work.record') }} />
          <SheetClose />
        </>
      )}
      <NativeForm>
        {f.r.error ? (
          <Section>
            <Text>{t(f.r.error.code === 'stale_version' ? 'integration.appChanged' : 'work.loadFailed')}</Text>
            <FormNavRow label={t('work.reload')} onPress={() => void f.reload()} />
          </Section>
        ) : null}
        {f.r.error && [403, 404].includes(f.r.error.status) ? null : !context ? (
          <Section>
            <Text>{t('work.loadFailed')}</Text>
          </Section>
        ) : !f.ready && !f.r.error ? (
          <Section>
            <FormLoading />
          </Section>
        ) : f.submitted ? (
          <Section>
            <Text>{t('integration.formSent')}</Text>
          </Section>
        ) : (
          <>
            {f.fields.some((field) => field.type === 'member' || recordChoice(field)) &&
            (!context.record || f.choices.error) ? (
              <Section footer={<Text>{t('integration.choices')}</Text>}>
                {f.choices.error ? (
                  <FormNavRow label={t('work.loadFailed')} onPress={() => void f.choices.refresh()} />
                ) : f.choices.loading ? (
                  <FormLoading />
                ) : null}
              </Section>
            ) : null}
            {f.fields.map((field) => (
              <Fragment key={`${f.epoch}:${field.id}`}>
                <FieldEditor
                  key={`${f.epoch}:${field.id}`}
                  field={field}
                  value={context.record ? f.r.data?.record.values[field.id] : f.values[field.id]}
                  change={(v) => f.change(field.id, v)}
                  readonly={!!context.record || (recordChoice(field) && !choiceCard(context.runtime, field))}
                  disabled={f.saving || !!f.r.error}
                  files={f.r.data?.files}
                  options={
                    field.type === 'member'
                      ? (f.choices.data?.[field.id] ?? [])
                      : context.record
                        ? Object.entries(f.r.data?.linked ?? {}).map(([id, r]) => ({ id, label: r.title }))
                        : (f.choices.data?.[field.id] ?? [])
                  }
                  uploadPath={context.record ? undefined : `/api/tables/bases/${context.runtime.base.id}/files`}
                />
                {!context.record && recordChoice(field) && !choiceCard(context.runtime, field) ? (
                  <Section>
                    <FormNavRow
                      label={`${field.name} · ${t('integration.fieldWeb')}`}
                      onPress={() => void openLink(`${getApiBase()}${appCardPath(context.runtime, context.card.id)}`)}
                    />
                  </Section>
                ) : null}
              </Fragment>
            ))}
            {context.record && f.r.data ? <Actions f={f} /> : null}
          </>
        )}
      </NativeForm>
    </>
  );
}
function Actions({ f }: { f: ReturnType<typeof useAppCard> }) {
  const { runtime, card } = f.context!;
  const action = useAppAction(runtime, card, () => void f.r.refresh());
  return (
    <Section modifiers={[disabled(action.busy || !canAct(runtime, card.table_id) || !!f.r.error)]}>
      {card.actions.map((a) => (
        <FormNavRow key={a.id} label={a.name} onPress={() => void action.execute(a, f.r.data!.record)} />
      ))}
    </Section>
  );
}
