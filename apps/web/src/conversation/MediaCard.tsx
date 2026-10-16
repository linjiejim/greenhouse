import { useMe } from '../app/session';
import { saveBlob } from '../lib/save';
import { useState } from 'react';
import { Download, Image, Video, BookPlus, FileText } from 'lucide-react';
import { Button, ChatCard } from '@greenhouse/ui/kit';
import type { FileView } from '@greenhouse/contract';
import { useNotify } from '../app/notify';
import { useT } from '../lib/i18n';
import { api } from '../lib/api';
import { errorText } from '../lib/errors';
import { isImage } from '../data/files';
import { navigate } from '../lib/router';

export function MediaCard({ file }: { file: FileView }) {
  const t = useT();
  const notify = useNotify();
  const me = useMe();
  const [saving, setSaving] = useState(false);
  const image = isImage(file);
  const video = file.content_type === 'video/mp4';
  return (
    <ChatCard
      icon={image ? <Image size={16} /> : video ? <Video size={16} /> : <FileText size={16} />}
      title={file.name}
    >
      {image && (
        <a href={file.url} target="_blank" rel="noopener noreferrer">
          <img className="app-media-preview" src={file.url} alt={file.name} loading="lazy" />
        </a>
      )}
      {video && (
        <video className="app-media-preview" controls preload="metadata" src={file.url} aria-label={file.name} />
      )}
      <div className="app-media-actions">
        <Button
          size="sm"
          onClick={() => {
            void fetch(file.url)
              .then(async (response) => {
                if (!response.ok) throw new Error('download_failed');
                saveBlob(await response.blob(), file.name);
                void api.metrics.adopt({ kind: 'download', file_id: file.id }).catch(() => undefined);
              })
              .catch((error: unknown) => notify(errorText(error, t)));
          }}
        >
          <Download size={14} />
          {t('media.download')}
        </Button>
        {me.modules.knowledge !== false && (
          <Button
            size="sm"
            loading={saving}
            disabled={saving}
            onClick={() => {
              setSaving(true);
              void api.media
                .save(file.id)
                .then((saved) => {
                  notify(t('media.saved'));
                  navigate({ page: 'knowledge', space: 'personal', file: saved.id });
                })
                .catch((error: unknown) => notify(errorText(error, t)))
                .finally(() => setSaving(false));
            }}
          >
            <BookPlus size={14} />
            {t('media.save')}
          </Button>
        )}
      </div>
    </ChatCard>
  );
}
