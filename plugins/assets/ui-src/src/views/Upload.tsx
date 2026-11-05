import { useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, CircleAlert, Copy as CopyIcon, X } from 'lucide-react';
import { useT, type StringKey } from '../i18n';
import { useLibrary } from '../state';
import { ACTIVE, useQueue, type BatchInfo, type QueueItem } from '../upload/queue';
import { FacetPicker } from '../components/facets';
import { Button, Dialog, Field, IconButton, Select, TagInput, TextArea, TextInput } from '../components/ui';

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
          <Button variant="primary" onClick={start} disabled={!config}>
            {t('startUpload')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {!one ? <p className="text-[13px] text-fg-muted">{t('batchInfoHint')}</p> : null}
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
          <Select value={info.collection_id ?? ''} onChange={(e) => setInfo({ ...info, collection_id: e.target.value || undefined })}>
            <option value="">—</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
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
  useEffect(() => {
    // Leaving the page mid-upload would lose the remaining files.
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [active]);
  if (!open || !items.length) return null;
  const count = (s: QueueItem['status']) => items.filter((i) => i.status === s).length;
  return (
    <div className="fixed right-4 bottom-4 z-30 flex max-h-[60vh] w-[360px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-edge bg-surface-canvas shadow-xl">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-edge px-3">
        <span className="min-w-0 flex-1 truncate text-[13px] font-bold">
          {active
            ? `${t('queue')} · ${items.length - active}/${items.length}`
            : t('queueDone', { added: count('added'), dupes: count('duplicate') + count('binned'), failed: count('failed') })}
        </span>
        <IconButton label={collapsed ? 'expand' : 'collapse'} onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </IconButton>
        {!active ? (
          <IconButton
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
            <li key={item.id} className="flex items-center gap-2 border-b border-edge px-3 py-2 last:border-b-0">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px]" title={item.file.name}>
                  {item.file.name}
                </div>
                <div className="mt-1 flex items-center gap-2">
                  {ACTIVE.has(item.status) ? (
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-muted">
                      <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(item.progress * 100)}%` }} />
                    </div>
                  ) : null}
                  <span
                    className={`shrink-0 text-[12px] ${item.status === 'failed' ? 'text-danger' : 'text-fg-muted'}`}
                    title={item.error}
                  >
                    {item.error === 'tooLarge' || item.error === 'unsupported' ? t(item.error) : t(LABEL[item.status])}
                  </span>
                </div>
              </div>
              {item.status === 'added' ? <CheckCircle2 size={16} className="text-success" /> : null}
              {item.status === 'duplicate' || item.status === 'binned' ? (
                <a href={item.assetId ? `#/asset/${encodeURIComponent(item.assetId)}` : undefined} title={t('duplicate')}>
                  <CopyIcon size={16} className="text-fg-muted" />
                </a>
              ) : null}
              {item.status === 'failed' && item.error !== 'tooLarge' && item.error !== 'unsupported' && config ? (
                <Button compact variant="ghost" onClick={() => retry(item.id, config)}>
                  {t('retry')}
                </Button>
              ) : item.status === 'failed' ? (
                <CircleAlert size={16} className="text-danger" />
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
