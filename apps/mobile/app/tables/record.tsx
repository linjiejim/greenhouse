import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Section, ProgressView } from '@expo/ui/swift-ui';
import { NativeForm, FormNavRow } from '../../src/ui/native-form';
import { FormChrome, SheetClose, useLeaveSheetTo } from '../../src/ui/sheet-chrome';
import { FieldEditor } from '../../src/tables/fields';
import { useRecordEditor } from '../../src/tables/use-record-editor';
import { useT } from '../../src/lib/i18n';
import { toolbarIcon } from '../../src/ui/toolbar-icon';
export default function Record() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const f = useRecordEditor(id);
  const t = useT();
  const router = useRouter();
  const leaveTo = useLeaveSheetTo();
  return (
    <>
      {f.editing ? (
        <FormChrome
          protectNavigation
          title={t('work.recordEdit')}
          dirty={f.dirty}
          canSave={f.canSave}
          saving={f.saving}
          onSave={() => void f.save()}
          onReload={() => void f.reload()}
        />
      ) : (
        <>
          <Stack.Screen options={{ title: t('work.record') }} />
          <SheetClose />
        </>
      )}
      {!f.editing && f.editable ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button icon={toolbarIcon('pen')} accessibilityLabel={t('work.recordEdit')} onPress={f.begin} />
        </Stack.Toolbar>
      ) : null}
      <NativeForm>
        {f.table && f.current ? (
          <>
            {f.table.fields.map((field) => (
              <FieldEditor
                key={`${f.epoch}:${field.id}:${f.editing}`}
                field={field}
                files={f.current!.detail.files}
                uploadPath={`/api/tables/bases/${f.current!.base.id}/files`}
                value={(f.editing ? f.values : f.current!.detail.record.values)[field.id]}
                readonly={!f.editing}
                change={(value) => f.change(field.id, value)}
              />
            ))}
            <Section>
              {!f.editing ? (
                <FormNavRow
                  label={t('integration.handoff')}
                  onPress={() => leaveTo({ pathname: '/tables/handoff', params: { id } })}
                />
              ) : null}
              <FormNavRow
                label={t('work.comments')}
                onPress={() => router.push({ pathname: '/comments', params: { id, kind: 'record' } })}
              />
            </Section>
          </>
        ) : (
          <Section>
            {f.resource.loading ? (
              <ProgressView />
            ) : (
              <FormNavRow label={t('work.loadFailed')} onPress={() => void f.resource.refresh()} />
            )}
          </Section>
        )}
      </NativeForm>
    </>
  );
}
