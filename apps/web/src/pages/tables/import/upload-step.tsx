/**
 * Import wizard · upload: a drop zone that is also a file picker (click,
 * Enter / Space). Hands the first file to the wizard; size is checked there.
 */

import { useRef, useState } from 'react';
import { Spinner } from '../../../components/ui';
import { Upload } from '../../../lib/icons';
import { useT } from '../../../lib/i18n';

const ACCEPT = '.csv,.tsv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function ImportUploadStep({ busy, onFile }: { busy: boolean; onFile: (file: File | undefined) => void }) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const pick = () => {
    if (!busy) inputRef.current?.click();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-busy={busy}
      data-testid="tables-import-dropzone"
      onClick={pick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          pick();
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (!busy) onFile(event.dataTransfer.files[0]);
      }}
      className={`cursor-pointer rounded-lg border border-dashed px-4 py-12 text-center transition-colors ${
        dragging ? 'border-primary-500 bg-primary-subtle' : 'border-edge-strong hover:bg-surface-muted'
      }`}
    >
      {busy ? (
        <Spinner className="mx-auto h-5 w-5 text-fg-faint" />
      ) : (
        <Upload size={20} className="mx-auto text-fg-faint" />
      )}
      <div className="mt-2 text-sm text-fg-secondary">
        {busy ? t('tables.imports.reading') : t('tables.imports.dropHint')}
      </div>
      <div className="mt-0.5 text-xs text-fg-faint">{t('tables.imports.limits')}</div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        data-testid="tables-import-file"
        onChange={(event) => {
          onFile(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
    </div>
  );
}
