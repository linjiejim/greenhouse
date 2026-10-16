import { errorText } from '../lib/errors';
/** Choose or remove a picture (avatar, logo): uploads it, then hands the file id over. */

import { useRef, useState, type ReactNode } from 'react';
import { Button } from '@greenhouse/ui/kit';
import { useNotify } from '../app/notify';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';

export function ImagePicker({
  preview,
  purpose,
  hasImage,
  onPick,
}: {
  preview: ReactNode;
  purpose: 'avatar' | 'branding';
  hasImage: boolean;
  /** A new file id, or null to remove the picture. */
  onPick: (fileId: string | null) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const notify = useNotify();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      notify(errorText(error, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="app-image-picker">
      {preview}
      <Button size="sm" loading={busy} onClick={() => input.current?.click()}>
        {hasImage ? t('image.replace') : t('image.choose')}
      </Button>
      {hasImage && (
        <Button size="sm" kind="ghost" disabled={busy} onClick={() => void run(() => onPick(null))}>
          {t('image.remove')}
        </Button>
      )}
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          void run(async () => {
            const uploaded = await api.files.upload(file, { purpose });
            await onPick(uploaded.id);
          });
        }}
      />
    </div>
  );
}
