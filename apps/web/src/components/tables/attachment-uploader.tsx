/**
 * Upload-only attachment control: for people who may add files to a record but
 * cannot browse the Base's Drive (a form's audience; later, app forms). Files go
 * through the caller's `upload` (e.g. `POST /api/forms/:id/uploads`) and the
 * returned ids become the field's value; the server binds them on submit.
 * Members editing a record pick from the Base's files instead (`AttachmentPicker`).
 */

import React, { useRef, useState } from 'react';
import type { TableFormUploadView } from '@greenhouse/types/tables';
import { Button, IconButton, Spinner } from '../ui';
import { Paperclip, Upload, X } from '../../lib/icons';
import { formatFileSize } from '../../lib/api/drive';
import { useT } from '../../lib/i18n';

export type AttachmentUpload = (file: File) => Promise<TableFormUploadView>;

export interface AttachmentUploaderProps {
  value: Array<number | string>;
  onChange: (value: Array<number | string>) => void;
  upload: AttachmentUpload;
  label: string;
  disabled?: boolean;
  id?: string;
  'aria-describedby'?: string;
}

export function AttachmentUploader({
  value,
  onChange,
  upload,
  label,
  disabled = false,
  id,
  'aria-describedby': describedBy,
}: AttachmentUploaderProps) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<Record<number, TableFormUploadView>>({});
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const ids = value.filter((entry): entry is number => typeof entry === 'number');

  const add = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    setError('');
    let next = ids;
    try {
      for (const file of Array.from(list)) {
        const stored = await upload(file);
        setFiles((current) => ({ ...current, [stored.id]: stored }));
        next = [...next, stored.id];
        onChange(next);
      }
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : t('tables.forms.upload.failed'));
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div id={id} role="group" aria-label={label} aria-describedby={describedBy} className="space-y-2">
      {ids.length === 0 ? (
        <p className="text-xs text-fg-faint">{t('tables.forms.upload.none')}</p>
      ) : (
        <ul className="divide-y divide-edge rounded-md border border-edge">
          {ids.map((fileId) => {
            const file = files[fileId];
            const name = file?.name ?? t('tables.attachments.fileNumber', { id: fileId });
            return (
              <li key={fileId} className="flex items-center gap-2 px-3 py-1.5 text-sm text-fg">
                <Paperclip size={13} className="shrink-0 text-fg-muted" />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {file && <span className="text-[11px] text-fg-faint">{formatFileSize(file.size)}</span>}
                <IconButton
                  size="compact"
                  variant="destructive"
                  label={t('tables.forms.upload.remove', { name })}
                  disabled={disabled}
                  onClick={() => onChange(ids.filter((entry) => entry !== fileId))}
                >
                  <X size={13} />
                </IconButton>
              </li>
            );
          })}
        </ul>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || uploading}
        onClick={() => input.current?.click()}
      >
        {uploading ? <Spinner className="mr-1.5" /> : <Upload size={13} className="mr-1.5" />}
        {uploading ? t('tables.forms.upload.uploading') : t('tables.forms.upload.button')}
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        className="hidden"
        data-testid="attachment-upload-input"
        onChange={(event) => void add(event.target.files)}
      />
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
