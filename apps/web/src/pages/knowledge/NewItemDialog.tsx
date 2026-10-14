/**
 * 新建 (KNOW-01, KNOW-05, KNOW-14): a doc (blank or from a template), a folder, or files, in the
 * folder the member is looking at or at the root of a space. A new doc opens in the editor.
 */

import { useId, useRef, useState, type FormEvent } from 'react';
import { Upload as UploadIcon } from 'lucide-react';
import { Button, Field, FieldGroup, Input, Overlay, OverlayActions, Segmented, Select } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import { DOC_TITLE_MAX, FOLDER_NAME_MAX, type KnowledgeSpace } from '@greenhouse/contract';
import { formatSize } from '../../data/files';
import { useKnowledgeActions, useTemplates } from '../../data/knowledge';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { UploadList } from './parts';
import { useUploads } from './uploads';

export type NewKind = 'doc' | 'folder' | 'upload';

/** Where new things go: a folder (by name, for the form), or the root of a space. */
export interface KnowledgeTarget {
  space: KnowledgeSpace;
  folderId?: string;
  folderName?: string;
}

export function NewItemDialog({
  kind = 'doc',
  target,
  onClose,
}: {
  kind?: NewKind;
  target: KnowledgeTarget;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const formId = useId();
  const actions = useKnowledgeActions();
  const uploads = useUploads();
  const [type, setType] = useState<NewKind>(kind);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('');
  const [where, setWhere] = useState(target.folderId ? `folder:${target.folderId}` : `space:${target.space}`);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const templates = useTemplates(type === 'doc');

  const places = [
    ...(target.folderId
      ? [{ value: `folder:${target.folderId}`, label: target.folderName ?? t('knowledge.thisFolder') }]
      : []),
    { value: 'space:team', label: t('knowledge.teamRoot') },
    { value: 'space:personal', label: t('knowledge.myRoot') },
  ];
  const place = () => {
    const [kindOf, value] = where.split(':') as ['folder' | 'space', string];
    return kindOf === 'folder' ? { folder_id: value } : { space: value as KnowledgeSpace };
  };
  const placeRoute = () => {
    const at = place();
    return at.folder_id
      ? ({ page: 'folder', id: at.folder_id } as const)
      : ({ page: 'knowledge', space: at.space } as const);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (type === 'upload') {
      if (!files.length) return setError(t('knowledge.pickFiles'));
      setBusy(true);
      const done = await uploads.start(files, place());
      setBusy(false);
      if (done.length === files.length) {
        onClose();
        navigate(placeRoute());
      }
      return;
    }
    const title = name.trim();
    if (!title && !(type === 'doc' && template)) return setError(t('knowledge.nameRequired'));
    setBusy(true);
    try {
      if (type === 'folder') {
        const folder = await actions.createFolder.mutateAsync({ name: title, ...place() });
        onClose();
        navigate({ page: 'folder', id: folder.id });
      } else {
        const doc = await actions.createDoc.mutateAsync({
          ...(title ? { title } : {}),
          ...(template ? { template_id: template } : {}),
          ...place(),
        });
        onClose();
        navigate({ page: 'doc', id: doc.id, edit: true });
      }
    } catch (caught) {
      setError(errorText(caught, t));
      setBusy(false);
    }
  };

  const submitLabel = {
    doc: t('knowledge.createDoc'),
    folder: t('knowledge.createFolder'),
    upload: t('knowledge.uploadNow'),
  };
  return (
    <Overlay variant="dialog" title={t('knowledge.new')} onClose={onClose} beforeClose={() => !uploads.busy}>
      <form id={formId} className="app-form" noValidate onSubmit={(event) => void submit(event)}>
        <FieldGroup label={t('knowledge.kind')}>
          <Segmented
            label={t('knowledge.kind')}
            items={[
              { value: 'doc', label: t('knowledge.doc') },
              { value: 'folder', label: t('knowledge.folder') },
              { value: 'upload', label: t('knowledge.uploadFiles') },
            ]}
            value={type}
            onChange={(value) => {
              setType(value as NewKind);
              setError('');
            }}
          />
        </FieldGroup>
        {type === 'upload' ? (
          <FieldGroup label={t('knowledge.files')} description={t('knowledge.filesHint')} error={error || undefined}>
            <div className="app-inline-actions">
              <Button onClick={() => picker.current?.click()}>
                <UploadIcon size={icon.md} strokeWidth={icon.stroke} />
                {t('knowledge.chooseFiles')}
              </Button>
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                aria-label={t('knowledge.chooseFiles')}
                onChange={(event) => {
                  setFiles(Array.from(event.target.files ?? []));
                  setError('');
                  event.target.value = '';
                }}
              />
            </div>
            {files.length > 0 && !uploads.items.length && (
              <ul className="app-uploads" aria-label={t('knowledge.files')}>
                {files.map((file) => (
                  <li key={`${file.name}:${file.size}:${file.lastModified}`}>
                    <span className="app-uploads-name">{file.name}</span>
                    <span className="app-uploads-meta">{formatSize(file.size, locale)}</span>
                  </li>
                ))}
              </ul>
            )}
            <UploadList items={uploads.items} onRetry={uploads.retry} onDismiss={uploads.dismiss} />
          </FieldGroup>
        ) : (
          <Field
            label={type === 'doc' ? t('knowledge.title') : t('knowledge.name')}
            error={error || undefined}
            required={!template}
          >
            <Input
              data-autofocus
              value={name}
              maxLength={type === 'doc' ? DOC_TITLE_MAX : FOLDER_NAME_MAX}
              placeholder={type === 'doc' && template ? t('knowledge.templateTitle') : undefined}
              onChange={(event) => {
                setName(event.target.value);
                setError('');
              }}
            />
          </Field>
        )}
        {type === 'doc' && templates.items.length > 0 && (
          <FieldGroup label={t('knowledge.template')}>
            <Select
              label={t('knowledge.template')}
              value={template}
              options={[
                { value: '', label: t('knowledge.blank') },
                ...templates.items.map((item) => ({ value: item.id, label: item.name })),
              ]}
              onChange={setTemplate}
            />
          </FieldGroup>
        )}
        {/* A group, not a <label>: a label around a picker reopens it after a pick. */}
        <FieldGroup label={t('knowledge.where')}>
          <Select label={t('knowledge.where')} value={where} options={places} onChange={setWhere} />
        </FieldGroup>
      </form>
      <OverlayActions>
        <Button onClick={onClose} disabled={uploads.busy}>
          {t('common.cancel')}
        </Button>
        <Button kind="primary" type="submit" form={formId} loading={busy}>
          {submitLabel[type]}
        </Button>
      </OverlayActions>
    </Overlay>
  );
}
