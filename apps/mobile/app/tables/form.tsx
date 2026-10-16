import { useLocalSearchParams } from 'expo-router';
import { Section, Text } from '@expo/ui/swift-ui';
import { NativeForm, FormLoading, FormNavRow } from '../../src/ui/native-form';
import { FormChrome } from '../../src/ui/sheet-chrome';
import { FieldEditor } from '../../src/tables/fields';
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
            <Section>
              <Text>
                {f.submitted
                  ? form.success_message || t('work.submitted')
                  : form.status === 'draft'
                    ? t('work.draft')
                    : form.single_submit && form.submitted
                      ? t('work.submitted')
                      : form.description || form.name}
              </Text>
            </Section>
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
