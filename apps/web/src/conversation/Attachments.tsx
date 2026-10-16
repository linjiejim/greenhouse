import { MediaCard } from './MediaCard';
/** A message's files (CONV-08): pictures inline, the rest as chips that download. */

import { Download, FileText } from 'lucide-react';
import { formatSize, isImage, useFiles } from '../data/files';
import { cx } from '../lib/cx';
import { useI18n } from '../lib/i18n';

export function Attachments({ ids, mine = false }: { ids: string[]; mine?: boolean }) {
  const { locale, t } = useI18n();
  const { files, loading } = useFiles(ids);
  if (!ids.length) return null;
  const images = files.filter((file) => isImage(file) && file.purpose !== 'artifact');
  const others = files.filter((file) => !isImage(file) && file.purpose !== 'artifact');
  return (
    <div className={cx('app-message-files', mine && 'is-mine')}>
      {files
        .filter((file) => file.purpose === 'artifact')
        .map((file) => (
          <MediaCard key={file.id} file={file} />
        ))}
      {images.map((file) => (
        <a key={file.id} className="app-message-image" href={file.url} target="_blank" rel="noopener noreferrer">
          <img src={file.url} alt={file.name} loading="lazy" />
        </a>
      ))}
      {others.map((file) => (
        <a
          key={file.id}
          className="app-attachment is-download"
          href={file.url}
          download={file.name}
          aria-label={t('message.downloadFile', { name: file.name })}
        >
          <FileText size={16} />
          <span className="app-attachment-name">{file.name}</span>
          <span className="app-attachment-size">{formatSize(file.size_bytes, locale)}</span>
          <Download size={14} />
        </a>
      ))}
      {loading && !files.length && <span className="app-attachment is-loading" aria-label={t('common.loading')} />}
    </div>
  );
}
