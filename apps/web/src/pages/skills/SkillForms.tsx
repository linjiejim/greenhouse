import { useOverlayDraft } from '../../lib/useOverlayDraft';
/**
 * Making skills: a template (instructions with `{{key}}` blanks and the fields that fill them) or
 * a SKILL.md package uploaded as a ZIP; and a new version of either. Versions never change once
 * saved, so a new one needs a change note.
 */

import { useRef, useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  Button,
  Checkbox,
  Field,
  FieldGroup,
  IconButton,
  Input,
  Overlay,
  OverlayActions,
  Segmented,
  Switch,
  TextArea,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { SkillDetail, SkillVariable } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useNotify } from '../../app/notify';
import { useSkillActions } from '../../data/skills';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';

type Space = 'personal' | 'team';
type Field_ = { key: string; label: string; choice: boolean; options: string; required: boolean };

const toFields = (variables: SkillVariable[]): Field_[] =>
  variables.map((variable) => ({
    key: variable.key,
    label: variable.label,
    choice: variable.type === 'choice',
    options: (variable.options ?? []).join(', '),
    required: variable.required !== false,
  }));

const toVariables = (fields: Field_[]): SkillVariable[] =>
  fields
    .filter((field) => field.key.trim() && field.label.trim())
    .map((field) => ({
      key: field.key.trim(),
      label: field.label.trim(),
      type: field.choice ? 'choice' : 'text',
      ...(field.choice
        ? {
            options: field.options
              .split(/[,，\n]/)
              .map((option) => option.trim())
              .filter(Boolean),
          }
        : {}),
      required: field.required,
    }));

/** Server messages for input it refused are specific; anything else gets the dictionary's words. */
const failure = (error: unknown, t: Parameters<typeof errorText>[1]) =>
  error instanceof ApiClientError && error.status < 500 && error.code === 'invalid_input'
    ? error.message
    : errorText(error, t);

function SpacePicker({ value, onChange }: { value: Space; onChange: (space: Space) => void }) {
  const { t } = useI18n();
  return (
    <FieldGroup label={t('skills.space')} description={t('skills.spaceHint')}>
      <Segmented
        label={t('skills.space')}
        items={[
          { value: 'personal', label: t('skills.personal') },
          { value: 'team', label: t('skills.team') },
        ]}
        value={value}
        onChange={(next) => onChange(next as Space)}
      />
    </FieldGroup>
  );
}

function FieldsEditor({ fields, onChange }: { fields: Field_[]; onChange: (fields: Field_[]) => void }) {
  const { t } = useI18n();
  const set = (index: number, change: Partial<Field_>) =>
    onChange(fields.map((field, at) => (at === index ? { ...field, ...change } : field)));
  return (
    <FieldGroup label={t('skills.fields')} description={t('skills.fieldsHint')}>
      <div className="app-skill-fields">
        {fields.map((field, index) => (
          <div key={index} className="app-skill-field" role="group" aria-label={t('skills.fieldN', { n: index + 1 })}>
            <Input
              aria-label={t('skills.fieldKey')}
              placeholder={t('skills.fieldKey')}
              value={field.key}
              onChange={(event) => set(index, { key: event.target.value })}
            />
            <Input
              aria-label={t('skills.fieldLabel')}
              placeholder={t('skills.fieldLabel')}
              value={field.label}
              onChange={(event) => set(index, { label: event.target.value })}
            />
            <Checkbox
              label={t('skills.fieldChoice')}
              checked={field.choice}
              onChange={(choice) => set(index, { choice })}
            />
            {field.choice && (
              <Input
                aria-label={t('skills.fieldOptions')}
                placeholder={t('skills.fieldOptions')}
                value={field.options}
                onChange={(event) => set(index, { options: event.target.value })}
              />
            )}
            <Checkbox
              label={t('skills.fieldRequired')}
              checked={field.required}
              onChange={(required) => set(index, { required })}
            />
            <IconButton
              label={t('skills.removeField')}
              size="sm"
              onClick={() => onChange(fields.filter((_, at) => at !== index))}
            >
              <Trash2 size={icon.sm} />
            </IconButton>
          </div>
        ))}
        {fields.length < 10 && (
          <div>
            <Button
              size="sm"
              onClick={() => onChange([...fields, { key: '', label: '', choice: false, options: '', required: true }])}
            >
              <Plus size={icon.sm} />
              {t('skills.addField')}
            </Button>
          </div>
        )}
      </div>
    </FieldGroup>
  );
}

/** A new template skill, or (`skill`) a new version of a template. */
export function SkillDrawer({ skill, onClose }: { skill?: SkillDetail; onClose: () => void }) {
  const { t } = useI18n();
  const notify = useNotify();
  const actions = useSkillActions();
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState(skill?.body ?? '');
  const [fields, setFields] = useState<Field_[]>(toFields(skill?.variables ?? []));
  const [computer, setComputer] = useState(skill?.requirements.computer ?? false);
  const [space, setSpace] = useState<Space>('personal');
  const [changelog, setChangelog] = useState('');
  const [error, setError] = useState('');
  const busy = actions.create.isPending || actions.addVersion.isPending;

  const dismiss = useOverlayDraft(
    { name, displayName, description, body, fields, computer, space, changelog },
    busy,
    onClose,
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    const variables = toVariables(fields);
    const requirements = { computer, connectors: skill?.requirements.connectors ?? [] };
    try {
      if (skill) {
        if (!changelog.trim()) return setError(t('skills.changelogRequired'));
        await actions.addVersion.mutateAsync({
          id: skill.id,
          input: { changelog: changelog.trim(), body, variables, requirements },
        });
        notify(t('skills.versionSaved'));
        dismiss.saved();
      } else {
        const created = await actions.create.mutateAsync({
          kind: 'template',
          name: name.trim(),
          ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
          description: description.trim(),
          body,
          variables,
          requirements,
          space,
        });
        dismiss.saved();
        navigate({ page: 'skill', id: created.id });
      }
    } catch (caught) {
      setError(failure(caught, t));
    }
  };

  return (
    <>
      <Overlay
        title={skill ? t('skills.newVersionOf', { name: skill.display_name || skill.name }) : t('skills.new')}
        onClose={onClose}
        beforeClose={dismiss.beforeClose}
      >
        <form {...dismiss.formProps} id="skill-form" className="app-form" onSubmit={(event) => void submit(event)}>
          {!skill && (
            <>
              <Field label={t('skills.name')} description={t('skills.nameHint')} required>
                <Input value={name} maxLength={64} onChange={(event) => setName(event.target.value)} />
              </Field>
              <Field label={t('skills.displayName')}>
                <Input value={displayName} maxLength={80} onChange={(event) => setDisplayName(event.target.value)} />
              </Field>
              <Field label={t('skills.description')} description={t('skills.descriptionHint')} required>
                <TextArea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} />
              </Field>
            </>
          )}
          <Field label={t('skills.body')} description={t('skills.bodyHint')} required>
            <TextArea rows={8} value={body} onChange={(event) => setBody(event.target.value)} />
          </Field>
          <FieldsEditor fields={fields} onChange={setFields} />
          <div className="app-setting-row is-plain">
            <span className="app-setting-text">
              <strong>{t('skills.needsComputer')}</strong>
              <span>{t('skills.needsComputerHint')}</span>
            </span>
            <Switch label={t('skills.needsComputer')} checked={computer} onChange={setComputer} />
          </div>
          {skill ? (
            <Field label={t('skills.changelog')} required>
              <Input value={changelog} maxLength={200} onChange={(event) => setChangelog(event.target.value)} />
            </Field>
          ) : (
            <SpacePicker value={space} onChange={setSpace} />
          )}
          {error && (
            <p className="app-request-error" role="alert">
              {error}
            </p>
          )}
        </form>
        <OverlayActions>
          <Button onClick={dismiss.close}>{t('common.cancel')}</Button>
          <Button kind="primary" type="submit" form="skill-form" loading={busy}>
            {skill ? t('skills.saveVersion') : t('skills.create')}
          </Button>
        </OverlayActions>
      </Overlay>
      {dismiss.confirmation}
    </>
  );
}

/** A SKILL.md package from a ZIP, or (`skill`) a new version of one. */
export function UploadSkillDialog({ skill, onClose }: { skill?: SkillDetail; onClose: () => void }) {
  const { t } = useI18n();
  const notify = useNotify();
  const actions = useSkillActions();
  const picker = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [space, setSpace] = useState<Space>('personal');
  const [changelog, setChangelog] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const dismiss = useOverlayDraft(
    { file: file ? { name: file.name, size: file.size, lastModified: file.lastModified } : null, space, changelog },
    busy,
    onClose,
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) return setError(t('skills.zipRequired'));
    if (skill && !changelog.trim()) return setError(t('skills.changelogRequired'));
    setBusy(true);
    try {
      if (skill) {
        const uploaded = await api.files.upload(file, { purpose: 'skill' });
        await actions.addVersion.mutateAsync({
          id: skill.id,
          input: { changelog: changelog.trim(), file_id: uploaded.id },
        });
        notify(t('skills.versionSaved'));
        dismiss.saved();
      } else {
        const created = await actions.upload.mutateAsync({ zip: file, space });
        dismiss.saved();
        navigate({ page: 'skill', id: created.id });
      }
    } catch (caught) {
      setError(failure(caught, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Overlay
        variant="dialog"
        title={skill ? t('skills.newVersion') : t('skills.upload')}
        onClose={onClose}
        beforeClose={dismiss.beforeClose}
      >
        <form {...dismiss.formProps} id="skill-upload" className="app-form" onSubmit={(event) => void submit(event)}>
          <FieldGroup label={t('skills.zip')} description={t('skills.zipHint')}>
            <span className="app-inline-actions">
              <Button onClick={() => picker.current?.click()}>{t('skills.chooseZip')}</Button>
              <span className="app-muted">{file?.name ?? ''}</span>
            </span>
            <input
              ref={picker}
              type="file"
              accept=".zip,application/zip"
              hidden
              aria-label={t('skills.zip')}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setError('');
              }}
            />
          </FieldGroup>
          {skill ? (
            <Field label={t('skills.changelog')} required>
              <Input value={changelog} maxLength={200} onChange={(event) => setChangelog(event.target.value)} />
            </Field>
          ) : (
            <SpacePicker value={space} onChange={setSpace} />
          )}
          {error && (
            <p className="app-request-error" role="alert">
              {error}
            </p>
          )}
        </form>
        <OverlayActions>
          <Button onClick={dismiss.close}>{t('common.cancel')}</Button>
          <Button kind="primary" type="submit" form="skill-upload" loading={busy}>
            {skill ? t('skills.saveVersion') : t('skills.upload')}
          </Button>
        </OverlayActions>
      </Overlay>
      {dismiss.confirmation}
    </>
  );
}
