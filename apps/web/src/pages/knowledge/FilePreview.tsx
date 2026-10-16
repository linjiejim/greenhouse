/**
 * A file of the knowledge base (KNOW-14), over its folder: pictures, PDFs, text, audio and video
 * shown, anything else to download. Bytes come only through the file's signed URL, made for this
 * member and refreshed before it ends; PDFs show from a copy in this page (a blob frame), since
 * the file itself is served sandboxed.
 */

import { useEffect, useState } from 'react';
import { Download, FileQuestion } from 'lucide-react';
import { Button, Empty, ErrorBox, Menu, Overlay, OverlayActions, Skeleton } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { KnowledgeFile } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useMe } from '../../app/session';
import { formatSize } from '../../data/files';
import { useKnowledgeFile } from '../../data/knowledge';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { fullTime, relativeTime } from '../../lib/time';
import { useItemMenu } from './actions';

/** Text files show up to this much. */
const TEXT_MAX = 200_000;

function TextPreview({ url }: { url: string }) {
  const { t } = useI18n();
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setText(null);
    setFailed(false);
    fetch(url, { signal: controller.signal })
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error(String(response.status)))))
      .then((body) => setText(body.length > TEXT_MAX ? `${body.slice(0, TEXT_MAX)}\n…` : body))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setFailed(!!error);
      });
    return () => controller.abort();
  }, [url]);
  if (failed) return <ErrorBox>{t('knowledge.previewFailed')}</ErrorBox>;
  if (text === null) return <Skeleton lines={8} />;
  return <pre className="app-file-text">{text}</pre>;
}

function PdfPreview({ url, name }: { url: string; name: string }) {
  const { t } = useI18n();
  const [frame, setFrame] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let blobUrl: string | null = null;
    let live = true;
    fetch(url)
      .then((response) => (response.ok ? response.blob() : Promise.reject(new Error(String(response.status)))))
      .then((blob) => {
        if (!live) return;
        blobUrl = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
        setFrame(blobUrl);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [url]);
  if (failed) return <ErrorBox>{t('knowledge.previewFailed')}</ErrorBox>;
  if (!frame) return <Skeleton lines={8} />;
  return <iframe className="app-preview-frame" title={name} src={frame} />;
}

function Preview({ file }: { file: KnowledgeFile }) {
  const { t } = useI18n();
  switch (file.preview) {
    case 'image':
      return <img className="app-file-image" src={file.url} alt={file.name} />;
    case 'pdf':
      return <PdfPreview url={file.url} name={file.name} />;
    case 'text':
      return <TextPreview url={file.url} />;
    case 'audio':
      return <audio className="app-file-media" controls src={file.url} aria-label={file.name} />;
    case 'video':
      return <video className="app-file-media" controls src={file.url} aria-label={file.name} />;
    default:
      return <Empty icon={<FileQuestion />} title={t('knowledge.noPreview')} />;
  }
}

export function FilePreview({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const me = useMe();
  const file = useKnowledgeFile(id);
  const { menuFor } = useItemMenu();
  const data = file.data;
  const missing = file.error instanceof ApiClientError && (file.error.status === 404 || file.error.status === 403);
  const title = data?.name ?? t('knowledge.file');
  const meta = data
    ? [
        data.size_bytes !== null ? formatSize(data.size_bytes, locale) : '',
        relativeTime(data.updated_at, { locale, timeZone: me.timezone }),
      ].filter(Boolean)
    : [];
  const menu = data ? menuFor(data, { download: false }) : [];
  return (
    <Overlay title={title} wide={data?.preview === 'pdf'} onClose={onClose}>
      {file.isPending ? (
        <Skeleton lines={8} />
      ) : missing ? (
        <Empty icon={<FileQuestion />} title={t('knowledge.fileMissing')} />
      ) : file.isError || !data ? (
        <ErrorBox onRetry={() => void file.refetch()}>{errorText(file.error, t)}</ErrorBox>
      ) : (
        <div className="app-overlay-stack">
          <p className="app-muted" title={fullTime(data.updated_at, { locale, timeZone: me.timezone })}>
            {meta.join(' · ')}
          </p>
          {data.archived_at && <p className="app-muted">{t('knowledge.fileArchived')}</p>}
          <Preview file={data} />
        </div>
      )}
      {data && (
        <OverlayActions>
          {menu.length > 0 && <Menu items={menu} />}
          <Button
            kind="primary"
            onClick={() => {
              const link = document.createElement('a');
              link.href = data.url;
              link.download = data.name;
              link.click();
            }}
          >
            <Download size={icon.md} strokeWidth={icon.stroke} />
            {t('knowledge.download')}
          </Button>
        </OverlayActions>
      )}
      {!data && !file.isPending && (
        <OverlayActions>
          <Button onClick={onClose}>{t('common.close')}</Button>
        </OverlayActions>
      )}
    </Overlay>
  );
}
