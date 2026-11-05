import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Images, Settings } from 'lucide-react';
import { useHeaderActions } from '@greenhouse/ui-tokens/react';
import { retryConnection, useEmbed } from './embed';
import { formatBytes, useT } from './i18n';
import { go, listHash, useRoute } from './router';
import { useLibrary } from './state';
import { guessType, useQueue } from './upload/queue';
import { AssetDetail } from './views/AssetDetail';
import { CollectionHeader, Collections } from './views/Collections';
import { Library } from './views/Library';
import { Manage } from './views/Manage';
import { BatchDialog, filesFromDrop, UploadPanel } from './views/Upload';
import { cx, Spinner, StateView, useDelayedFlag } from './components/ui';
import { api } from './api';

export function App() {
  const t = useT();
  const status = useEmbed((s) => s.status);
  const ready = status === 'ready';
  const route = useRoute();
  const { config, loadConfig, loadPeople, loadCollections } = useLibrary();
  const revision = useQueue((s) => s.revision);
  const [pending, setPending] = useState<File[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const [stats, setStats] = useState<{ active: number; bytes: number } | null>(null);
  const [changed, setChanged] = useState(0);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!ready) return;
    void loadConfig();
    void loadPeople();
    void loadCollections().catch(() => {});
  }, [ready, loadConfig, loadPeople, loadCollections]);
  useEffect(() => {
    if (ready) void api.stats().then(setStats, () => {});
  }, [ready, revision, changed]);

  // Upload lives in the host's title bar: one header for the whole page.
  useHeaderActions(
    config
      ? [
          { id: 'folder', label: t('uploadFolder'), icon: 'FolderPlus', onPress: () => folderInput.current?.click() },
          { id: 'upload', label: t('upload'), icon: 'Upload', onPress: () => filesInput.current?.click() },
        ]
      : [],
  );
  const slow = useDelayedFlag(!ready || !config, 300, 0);

  const accept = (files: File[]) => {
    const usable = files.filter((f) => (f.type || guessType(f.name)).match(/^(image|video)\//));
    if (usable.length) setPending(usable);
  };

  if (status === 'failed')
    return (
      <div className="flex h-full items-center justify-center">
        <StateView kind="error" title={t('notConnected')} hint={t('notConnectedHint')} onRetry={retryConnection} />
      </div>
    );
  if (!ready || !config)
    return <div className="flex h-full items-center justify-center">{slow ? <Spinner size={20} /> : null}</div>;

  const tab = route.view === 'manage' ? 'manage' : route.view === 'collections' || route.view === 'collection' ? 'collections' : 'library';
  const openAsset = route.view === 'library' || route.view === 'collection' ? route.asset : undefined;
  const closeAsset = () => go(listHash(route.view === 'collection' ? `#/collection/${encodeURIComponent(route.id)}` : '#/'));

  return (
    <div
      className="relative flex h-full flex-col"
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setDragging(false);
        accept(await filesFromDrop(e));
      }}
    >
      <nav className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-3" aria-label={t('library')}>
        {[
          { id: 'library', label: t('library'), icon: <Images size={16} />, href: '#/' },
          { id: 'collections', label: t('collections'), icon: <FolderOpen size={16} />, href: '#/collections' },
          ...(config.can_manage ? [{ id: 'manage', label: t('manage'), icon: <Settings size={16} />, href: '#/manage/facets' }] : []),
        ].map((item) => (
          <a
            key={item.id}
            href={item.href}
            aria-current={tab === item.id ? 'page' : undefined}
            className={cx(
              'flex h-8 items-center gap-1.5 rounded-control px-2.5 text-body font-medium pointer-coarse:h-11',
              tab === item.id ? 'bg-pressed text-foreground' : 'text-muted-foreground hover:bg-hover hover:text-foreground',
            )}
          >
            {item.icon}
            <span className="hidden sm:inline">{item.label}</span>
          </a>
        ))}
        <div className="flex-1" />
        {stats ? (
          <span className="mr-1 hidden text-caption text-muted-foreground tabular-nums md:inline">
            {t('count', { n: stats.active })} · {formatBytes(stats.bytes)}
          </span>
        ) : null}
        <input
          ref={filesInput}
          type="file"
          multiple
          data-testid="assets-files-input"
          hidden
          accept={[...config.types.image, ...config.types.video, '.heic', '.heif', '.mov'].join(',')}
          onChange={(e) => {
            accept([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
        <input
          ref={folderInput}
          type="file"
          hidden
          // @ts-expect-error — non-standard but supported by every desktop browser
          webkitdirectory=""
          onChange={(e) => {
            accept([...(e.target.files ?? [])].filter((f) => !f.name.startsWith('.')));
            e.target.value = '';
          }}
        />
      </nav>

      {route.view === 'collections' ? (
        <Collections />
      ) : route.view === 'manage' ? (
        <Manage tab={route.tab} />
      ) : route.view === 'collection' ? (
        <Library
          key={`collection:${route.id}:${changed}`}
          base={`#/collection/${encodeURIComponent(route.id)}`}
          collectionId={route.id}
          header={<CollectionHeader id={route.id} />}
        />
      ) : (
        <Library key={`library:${changed}`} base="#" />
      )}

      {openAsset ? <AssetDetail id={openAsset} onClose={closeAsset} onChanged={() => setChanged((n) => n + 1)} /> : null}
      {pending ? <BatchDialog files={pending} onClose={() => setPending(null)} /> : null}
      {dragging ? (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-card border-2 border-dashed border-ring bg-selected text-title-sm font-semibold text-primary-fg">
          {t('dropHere')}
        </div>
      ) : null}
      <UploadPanel />
    </div>
  );
}
