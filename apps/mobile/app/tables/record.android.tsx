import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { NativeForm, FormLoading, FormNavRow, FormSection, FormValueRow } from '../../src/ui/native-form.android';
import { FormChrome, SheetClose, useLeaveSheetTo } from '../../src/ui/sheet-chrome';
import { FieldEditor } from '../../src/tables/fields.android';
import { useRecordEditor } from '../../src/tables/use-record-editor';
import { useT } from '../../src/lib/i18n';
import { SheetActions } from '../../src/ui/sheet-actions';
import { NativeButton } from '../../src/ui/button.android';
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
        <SheetActions>
          <NativeButton label={t('work.recordEdit')} variant="prominent" size="large" fullWidth onPress={f.begin} />
        </SheetActions>
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
            <FormSection>
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
            </FormSection>
          </>
        ) : (
          <FormSection>
            {f.resource.loading ? <FormLoading /> : <FormValueRow label={t('work.loadFailed')} />}
            <FormNavRow label={t('common.retry')} onPress={() => void f.resource.refresh()} />
          </FormSection>
        )}
      </NativeForm>
    </>
  );
}
