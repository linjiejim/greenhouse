/**
 * Files (档案库) — the team's file cabinet and my own, as a first-class page.
 *
 * It is the knowledge cabinet (drive scope `kb`) seen from the files side: the
 * team shelf everyone shares and my personal shelf. Browsing, upload, preview,
 * rename / move / delete all go through the shared DriveBrowser and /api/drive,
 * which authorizes every node; the page only keeps the shelf, the open folder
 * and a deep-linked file in the URL (`#/files?shelf=&folder=&file=`) so links
 * from agents and the address bar land on the same view.
 */

import { useEffect, useState } from 'react';
import { filesPageHref, parseFilesLocation, shelfOfVisibility, type FilesShelf } from '@greenhouse/types/files';
import { ModulePage } from '../components/app/module-page';
import { DriveBrowser } from '../components/drive/drive-browser';
import { EmptyState, FilterPills, SearchInput, Spinner, Tag, toast } from '../components/ui';
import { FileText, Folder, Search } from '../lib/icons';
import { formatFileSize, searchKnowledgeCabinet, type DriveFile, type DriveFolder } from '../lib/api/drive';
import { formatDate } from '../lib/utils';
import { useT } from '../lib/i18n';

const SEARCH_DEBOUNCE_MS = 250;

function go(href: string) {
  window.location.hash = href;
}

export function FilesPage({ params }: { params: URLSearchParams }) {
  const t = useT();
  const location = parseFilesLocation(params);
  const { shelf } = location;
  const [query, setQuery] = useState('');
  const searching = query.trim().length > 0;

  return (
    <ModulePage
      moduleId="workspace.files"
      layout="list"
      tabs={
        <FilterPills
          variant="segment"
          items={[
            { key: 'team', label: t('files.teamShelf') },
            { key: 'personal', label: t('files.personalShelf') },
          ]}
          activeKey={searching ? null : shelf}
          onChange={(key) => {
            setQuery('');
            go(filesPageHref({ shelf: (key ?? 'team') as FilesShelf }));
          }}
        />
      }
      toolbar={
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={t('files.searchPlaceholder')}
          aria-label={t('files.searchPlaceholder')}
          className="w-full sm:max-w-xs"
        />
      }
    >
      {searching ? (
        <FilesSearchResults
          query={query.trim()}
          onOpen={(href) => {
            setQuery('');
            go(href);
          }}
        />
      ) : (
        <DriveBrowser
          key={shelf}
          owner={{ scope: 'kb', visibility: shelf === 'personal' ? 'private' : 'team' }}
          folderId={location.folderId ?? null}
          onFolderChange={(folderId) => go(filesPageHref({ shelf, folderId }))}
          previewFileId={location.fileId ?? null}
          onPreviewClose={() => {
            if (location.fileId) go(filesPageHref({ shelf, folderId: location.folderId }));
          }}
        />
      )}
    </ModulePage>
  );
}

function FilesSearchResults({ query, onOpen }: { query: string; onOpen: (href: string) => void }) {
  const t = useT();
  const [result, setResult] = useState<{ folders: DriveFolder[]; files: DriveFile[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    const timer = window.setTimeout(() => {
      searchKnowledgeCabinet(query)
        .then((found) => !cancelled && setResult(found))
        .catch((e) => {
          if (cancelled) return;
          toast((e as Error).message || t('common.loadFailed'), 'error');
          setResult({ folders: [], files: [] });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, t]);

  if (!result) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }
  if (result.folders.length === 0 && result.files.length === 0) {
    return (
      <EmptyState icon={Search} tone="neutral" title={t('files.noResults')} description={t('files.noResultsHint')} />
    );
  }

  const shelfTag = (visibility: 'team' | 'private' | null) => (
    <Tag size="xs" tone={visibility === 'private' ? 'neutral' : 'primary'}>
      {shelfOfVisibility(visibility) === 'personal' ? t('files.personalShelf') : t('files.teamShelf')}
    </Tag>
  );

  return (
    <div
      className="divide-y divide-edge overflow-hidden rounded-lg border border-edge"
      data-testid="files-search-results"
    >
      {result.folders.map((folder) => (
        <button
          key={`fd${folder.id}`}
          type="button"
          onClick={() => onOpen(filesPageHref({ shelf: shelfOfVisibility(folder.visibility), folderId: folder.id }))}
          className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface-muted"
        >
          <Folder size={18} className="flex-shrink-0 text-info" />
          <span className="min-w-0 flex-1 truncate text-sm text-fg" title={folder.name}>
            {folder.name}
          </span>
          {shelfTag(folder.visibility)}
        </button>
      ))}
      {result.files.map((file) => (
        <button
          key={`fl${file.id}`}
          type="button"
          onClick={() =>
            onOpen(
              filesPageHref({
                shelf: shelfOfVisibility(file.visibility),
                folderId: file.folder_id,
                fileId: file.id,
              }),
            )
          }
          className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface-muted"
        >
          <FileText size={18} className="flex-shrink-0 text-fg-muted" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-fg" title={file.name}>
              {file.name}
            </span>
            <span className="block text-[11px] text-fg-faint">
              {formatFileSize(file.size)} · {formatDate(file.updated_at)}
            </span>
          </span>
          {shelfTag(file.visibility)}
        </button>
      ))}
    </div>
  );
}
