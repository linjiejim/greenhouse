import { useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, CircleAlert, Copy as CopyIcon, X } from 'lucide-react';
import { useT, type StringKey } from '../i18n';
import { useLibrary } from '../state';
import { ACTIVE, useQueue, type BatchInfo, type QueueItem } from '../upload/queue';
import { FacetPicker } from '../components/facets';
import { Button, cx, Dialog, Field, IconButton, Select, TagInput, TextArea, TextInput } from '../components/ui';

/** Ask for this batch's shared information, then queue every file. */
export function BatchDialog({ files, onClose }: { files: File[]; onClose: () => void }) {
  const t = useT();
  const { config, collections } = useLibrary();
  const add = useQueue((s) => s.add);
  const [info, setInfo] = useState<BatchInfo>({ tags: [], facets: {} });
  const one = files.length === 1;
  const start = () => {
    if (!config) return;
    add(files, info, config);
    onClose();
  };
  return (
    <Dialog
      title={one ? files[0].name : t('files', { n: files.length })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" onClick={start} disabled={!config} data-testid="assets-start-upload">
            {t('startUpload')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {!one ? <p className="text-body-sm text-muted-foreground">{t('batchInfoHint')}</p> : null}
        {one ? (
          <Field label={t('title')}>
            <TextInput maxLength={200} value={info.title ?? ''} onChange={(e) => setInfo({ ...info, title: e.target.value })} />
          </Field>
        ) : null}
        <Field label={t('description')}>
          <TextArea
            maxLength={4000}
            value={info.description ?? ''}
            onChange={(e) => setInfo({ ...info, description: e.target.value })}
          />
        </Field>
        <Field label={t('tags')} hint={t('tagsHint')}>
          <TagInput value={info.tags} onChange={(tags) => setInfo({ ...info, tags })} />
        </Field>
        <Field label={t('source')} hint={t('sourceHint')}>
          <TextInput maxLength={500} value={info.source ?? ''} onChange={(e) => setInfo({ ...info, source: e.target.value })} />
        </Field>
        <Field label={t('addToCollection')}>
          <Select
            clearable
            value={info.collection_id}
            placeholder={t('noCollection')}
            onChange={(collection_id) => setInfo({ ...info, collection_id })}
            options={collections.map((c) => ({ value: c.id, label: c.name }))}
          />
        </Field>
        {config?.facets.length ? (
          <FacetPicker facets={config.facets} value={info.facets} onChange={(facets) => setInfo({ ...info, facets })} />
        ) : null}
      </div>
    </Dialog>
  );
}

const LABEL: Record<QueueItem['status'], StringKey> = {
  waiting: 'waiting',
  hashing: 'hashing',
  checking: 'checking',
  uploading: 'uploading',
  finishing: 'finishing',
  added: 'added',
  duplicate: 'duplicate',
  binned: 'binned',
  failed: 'failed',
};

/** The floating queue: one row per file, a summary when everything has settled. */
export function UploadPanel() {
  const t = useT();
  const { items, open, setOpen, clearFinished, retry } = useQueue();
  const config = useLibrary((s) => s.config);
  const [collapsed, setCollapsed] = useState(false);
  const active = items.filter((i) => ACTIVE.has(i.status)).length;
  const failures = items.filter((i) => i.status === 'failed').length;
  // Everything went in: the panel leaves on its own after 4 s; it stays while anything failed.
  useEffect(() => {
    if (!open || !items.length || active || failures) return;
    const timer = setTimeout(() => {
      clearFinished();
      setOpen(false);
    }, 4000);
    return () => clearTimeout(timer);
  }, [open, items.length, active, failures, clearFinished, setOpen]);
  useEffect(() => {
    // Leaving the page mid-upload would lose the remaining files.
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [active]);
  if (!open || !items.length) return null;
  const count = (s: QueueItem['status']) => items.filter((i) => i.status === s).length;
  const summary = [
    count('added') ? t('queueAdded', { n: count('added') }) : '',
    count('duplicate') + count('binned') ? t('queueDupes', { n: count('duplicate') + count('binned') }) : '',
    failures ? t('queueFailed', { n: failures }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div
      data-testid="assets-upload-queue"
      role="region"
      aria-label={t('queue')}
      className="fixed right-4 bottom-[max(16px,env(safe-area-inset-bottom))] z-30 flex max-h-[60vh] w-[360px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-menu border border-border bg-popover shadow-popover">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-label font-semibold tabular-nums" aria-live="polite">
          {active ? `${t('queue')} · ${items.length - active}/${items.length}` : summary || t('queueAllDone')}
        </span>
        <IconButton compact label={collapsed ? t('expand') : t('collapse')} onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </IconButton>
        {!active ? (
          <IconButton
            compact
            label={t('close')}
            onClick={() => {
              clearFinished();
              setOpen(false);
            }}
          >
            <X size={16} />
          </IconButton>
        ) : null}
      </div>
      {collapsed ? null : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0">
              <div className="min-w-0 flex-1">
                <div className="truncate text-body-sm" title={item.file.name}>
                  {item.file.name}
                </div>
                <div className="mt-1 flex items-center gap-2">
                  {ACTIVE.has(item.status) ? (
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.round(item.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                      <div className="h-full bg-primary transition-[width]" style={{ width: `${Math.round(item.progress * 100)}%` }} />
                    </div>
                  ) : null}
                  <span
                    className={cx('shrink-0 text-caption tabular-nums', item.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}
                    title={item.error}
                  >
                    {item.error === 'tooLarge' || item.error === 'unsupported'
                      ? t(item.error)
                      : item.status === 'uploading'
                        ? `${t('uploading')} ${Math.round(item.progress * 100)}%`
                        : t(LABEL[item.status])}
                  </span>
                </div>
              </div>
              {item.status === 'added' ? <CheckCircle2 size={16} className="text-success" /> : null}
              {item.status === 'duplicate' || item.status === 'binned' ? (
                <a href={item.assetId ? `#/asset/${encodeURIComponent(item.assetId)}` : undefined} title={t('duplicate')}>
                  <CopyIcon size={16} className="text-muted-foreground" />
                </a>
              ) : null}
              {item.status === 'failed' && item.error !== 'tooLarge' && item.error !== 'unsupported' && config ? (
                <Button compact variant="ghost" onClick={() => retry(item.id, config)}>
                  {t('retry')}
                </Button>
              ) : item.status === 'failed' ? (
                <CircleAlert size={16} className="text-destructive" />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Collect files from a drop, walking dropped folders (webkit entries) one level at a time. */
export async function filesFromDrop(event: DragEvent | React.DragEvent): Promise<File[]> {
  const items = [...(event.dataTransfer?.items ?? [])];
  const entries = items
    .map((item) => (item.kind === 'file' ? item.webkitGetAsEntry?.() : null))
    .filter((e): e is FileSystemEntry => Boolean(e));
  if (!entries.length) return [...(event.dataTransfer?.files ?? [])];
  const out: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      out.push(await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject)));
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  };
  for (const entry of entries) await walk(entry);
  return out.filter((f) => !f.name.startsWith('.'));
}
