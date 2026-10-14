import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { NativeForm, FormNavRow, FormSection, FormValueRow } from '../../src/ui/native-form.android';
import { FormChrome, SheetClose } from '../../src/ui/sheet-chrome';
import { FieldEditor } from '../../src/tables/fields.android';
import { useRecordEditor } from '../../src/tables/use-record-editor';
import { useT } from '../../src/lib/i18n';
import { toolbarIcon } from '../../src/ui/toolbar-icon.android';
export default function Record() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const f = useRecordEditor(id);
  const t = useT();
  const router = useRouter();
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
            <FormSection>
              <FormNavRow
                label={t('work.comments')}
                onPress={() => router.push({ pathname: '/comments', params: { id, kind: 'record' } })}
              />
            </FormSection>
          </>
        ) : (
          <FormSection>
            <FormValueRow label={f.resource.loading ? t('common.loading') : t('work.loadFailed')} />
            <FormNavRow label={t('common.retry')} onPress={() => void f.resource.refresh()} />
          </FormSection>
        )}
      </NativeForm>
    </>
  );
}
