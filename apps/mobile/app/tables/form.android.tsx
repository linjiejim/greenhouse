import { useLocalSearchParams } from 'expo-router';
import { NativeForm, FormSection, FormValueRow, FormNavRow } from '../../src/ui/native-form.android';
import { FormChrome } from '../../src/ui/sheet-chrome';
import { FieldEditor } from '../../src/tables/fields.android';
import { useFormFill } from '../../src/tables/use-record-editor';
import { useT } from '../../src/lib/i18n';
export default function FormFill() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const f = useFormFill(id);
  const t = useT();
  const form = f.form;
  return (
    <>
      <FormChrome
        protectNavigation
        title={form?.name ?? t('work.form')}
        dirty={f.dirty}
        canSave={f.canSave}
        saving={f.saving}
        onSave={() => void f.save()}
        saveLabel={form?.submit_label || t('work.submit')}
      />
      <NativeForm>
        {form ? (
          <>
            <FormSection>
              <FormValueRow
                label={
                  f.submitted
                    ? form.success_message || t('work.submitted')
                    : form.status === 'draft'
                      ? t('work.draft')
                      : form.single_submit && form.submitted
                        ? t('work.submitted')
                        : form.description || form.name
                }
              />
            </FormSection>
            {!f.submitted
              ? form.fields.map((field) => (
                  <FieldEditor
                    key={field.id}
                    field={field}
                    uploadPath={`/api/tables/forms/${id}/files`}
                    value={f.values[field.id]}
                    change={(v) => f.change(field.id, v)}
                  />
                ))
              : null}
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
