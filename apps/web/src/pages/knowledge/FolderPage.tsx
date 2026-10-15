/**
 * A folder (`#/knowledge/folder/:id`) or the root of a space (`#/knowledge?space=`), KNOW-01: docs,
 * files and folders together, as a list or a grid, in hand order, by name or by the latest change;
 * search inside it; new docs (blank or from a template), folders and uploads (several at once,
 * also dropped from the computer); the folder's own actions in "⋯" (share, export, rename, move,
 * archive). A file opens in a preview over the list (`?file=`). The list comes a page at a time
 * and ends with 显示更多.
 */

import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { FilePlus, FolderOpen, FolderPlus, Inbox, Search, Share2, Upload, Users } from 'lucide-react';
import {
  Badge,
  Banner,
  Button,
  Empty,
  ErrorBox,
  Menu,
  SearchInput,
  Segmented,
  Select,
  Skeleton,
  useContextMenu,
  type MenuEntry,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { KnowledgeItem, KnowledgeScope, KnowledgeSearchHit } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useMe } from '../../app/session';
import { useNotify } from '../../app/notify';
import { formatSize } from '../../data/files';
import { exportKnowledge, useFolder, useKnowledgeRoots, useKnowledgeSearch } from '../../data/knowledge';
import { usePeople } from '../../data/people';
import { cx } from '../../lib/cx';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { store, stored } from '../../lib/media';
import { href, navigate, type Route } from '../../lib/router';
import { relativeTime } from '../../lib/time';
import { Page, PageHeader } from '../../shell/Page';
import { useOpenOverlay } from '../../shell/overlays';
import { useItemMenu } from './actions';
import { useKnowledgeDnd } from './dnd';
import { FilePreview } from './FilePreview';
import { canArchive, canEdit, itemKey, oneFolder, routeOf, scopeOf, SORTS, sortItems, type Sort } from './helpers';
import type { KnowledgeTarget } from './NewItemDialog';
import { Crumbs, ItemIcon, UploadList, useSpaceName } from './parts';
import { revealFolders, setKnowledgeScope } from './scope';
import { useUploads } from './uploads';

const VIEWS = ['list', 'grid'] as const;
type View = (typeof VIEWS)[number];

/** One line under a row's name: what it is, how big, when it changed, whose it is when shared. */
function useMetaOf() {
  const { t, locale } = useI18n();
  const me = useMe();
  const { memberById } = usePeople();
  return (item: KnowledgeItem) =>
    [
      item.type === 'folder'
        ? t('knowledge.folder')
        : item.type === 'doc'
          ? item.is_template
            ? t('knowledge.templateBadge')
            : t('knowledge.doc')
          : item.size_bytes !== null
            ? formatSize(item.size_bytes, locale)
            : t('knowledge.file'),
      relativeTime(item.updated_at, { locale, timeZone: me.timezone }),
      item.space === 'personal' && item.owner_id && item.owner_id !== me.id
        ? memberById.get(item.owner_id)?.name
        : undefined,
    ]
      .filter(Boolean)
      .join(' · ');
}

function ItemRow({
  item,
  view,
  menu,
  dnd,
  dropAt,
}: {
  item: KnowledgeItem;
  view: View;
  menu: MenuEntry[];
  dnd: Record<string, unknown>;
  dropAt?: string | null;
}) {
  const { t } = useI18n();
  const metaOf = useMetaOf();
  const context = useContextMenu(menu, t('row.actionsFor', { name: item.name }));
  const route = routeOf(item);
  return (
    <li
      className={cx(
        view === 'grid' ? 'app-knowledge-card' : 'app-list-row is-static app-knowledge-row',
        context.open && 'is-menu-open',
        dropAt && `is-drop-${dropAt}`,
      )}
      {...dnd}
      {...context.handlers}
    >
      <a className="app-knowledge-open" href={href(route)}>
        <span className="app-knowledge-icon">
          <ItemIcon item={item} size={view === 'grid' ? icon.lg : icon.md} />
        </span>
        <span className="app-list-main">
          <span className="app-list-title">{item.name}</span>
          <span className="app-list-meta">{metaOf(item)}</span>
        </span>
      </a>
      {item.shared && <Share2 size={icon.sm} className="app-row-muted" aria-label={t('knowledge.isShared')} />}
      {menu.length > 0 && <Menu label={t('row.actionsFor', { name: item.name })} items={menu} />}
      {context.menu}
    </li>
  );
}

function SearchResults({ hits }: { hits: KnowledgeSearchHit[] }) {
  const { t } = useI18n();
  return (
    <ul className="app-list" aria-label={t('knowledge.results')}>
      {hits.map((hit) => (
        <li key={`${hit.type}:${hit.id}`}>
          <a
            className="app-list-row"
            href={href(routeOf({ type: hit.type, id: hit.id, folder_id: hit.folder_id, space: hit.space }))}
          >
            <span className="app-knowledge-icon">
              <ItemIcon item={{ type: hit.type, agent_id: null, content_type: null, is_template: false }} />
            </span>
            <span className="app-list-main">
              <span className="app-list-title">{hit.title}</span>
              <span className="app-list-meta">
                {[hit.path.map((entry) => entry.name).join(' / '), hit.snippet].filter(Boolean).join(' · ')}
              </span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

export function FolderPage({
  folderId,
  space,
  file,
}: {
  folderId: string | null;
  space?: KnowledgeScope;
  file?: string;
}) {
  const { t } = useI18n();
  const me = useMe();
  const notify = useNotify();
  const openOverlay = useOpenOverlay();
  const spaceName = useSpaceName();
  const scope: KnowledgeScope = space ?? 'team';
  const folder = useFolder(folderId);
  const roots = useKnowledgeRoots(scope, !folderId);
  // An Agent's private folder sits at the top of its owner's space; what is below it never shares.
  const above = folder.data?.path[0]?.id;
  const personal = useKnowledgeRoots('personal', !!above && folder.data?.space === 'personal');
  const { menuFor, restore } = useItemMenu();
  const uploads = useUploads();
  const picker = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sort, setSort] = useState<Sort>(() => stored('knowledge-sort', 'manual', SORTS));
  const [view, setView] = useState<View>(() => stored('knowledge-view', 'list', VIEWS));
  const [dropping, setDropping] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);

  const data = folder.data;
  const items = useMemo(
    () => (folderId ? (data?.children ?? []) : roots.items),
    [folderId, data?.children, roots.items],
  );
  const loading = folderId ? folder.isPending : roots.isPending;
  const error = folderId ? folder.error : roots.error;
  const list = folderId ? folder : roots;
  const archived = !!data?.archived_at;
  const title = folderId ? (data?.name ?? '') : spaceName(scope);
  const itemScope: KnowledgeScope = data ? scopeOf(data, me.id) : scope;
  const canAdd = folderId ? !!data && canEdit(data) : scope !== 'shared';
  const inAgent = !!data && (!!data.agent_id || personal.items.some((root) => root.id === above && !!root.agent_id));
  // Hand order is changed where the folder (or space root) may be changed, and never in 分享给我.
  const orderable = sort === 'manual' && canAdd;
  const target: KnowledgeTarget | null = folderId
    ? data
      ? { space: data.space, folderId: data.id, folderName: data.name }
      : null
    : scope === 'shared'
      ? null
      : { space: scope };
  const uploadTarget = target ? (target.folderId ? { folder_id: target.folderId } : { space: target.space }) : null;

  // Show where it lives in the directory.
  const pathKey = data ? [...data.path.map((entry) => entry.id), data.id].join('/') : '';
  useEffect(() => {
    if (folderId && data) {
      setKnowledgeScope(scopeOf(data, me.id));
      revealFolders([...data.path.map((entry) => entry.id), data.id]);
    } else if (!folderId && space) setKnowledgeScope(space);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId, space, pathKey, me.id]);

  const dnd = useKnowledgeDnd({
    onFiles: (files, into) => void uploads.start(files, { folder_id: into.id }),
  });
  const search = useKnowledgeSearch(debounced, folderId ? { folder_id: folderId } : { space: scope });
  const sorted = useMemo(() => sortItems(items, sort), [items, sort]);

  const upload = (files: File[]) => {
    if (!uploadTarget || !files.length) return;
    void uploads.start(files, uploadTarget).then((done) => {
      if (done.length) notify(t('knowledge.uploaded', { count: done.length }));
    });
  };

  const openNew = (kind: 'doc' | 'folder' | 'upload') => target && openOverlay({ type: 'new-knowledge', kind, target });
  const closePreview = () => {
    const back: Route = folderId ? { page: 'folder', id: folderId } : { page: 'knowledge', space: scope };
    navigate(back, { replace: true });
  };

  const pageMenu: MenuEntry[] = [];
  if (canAdd && target) {
    pageMenu.push(
      {
        label: t('knowledge.upload'),
        icon: <Upload size={icon.md} strokeWidth={icon.stroke} />,
        onClick: () => picker.current?.click(),
      },
      {
        label: t('knowledge.newFolder'),
        icon: <FolderPlus size={icon.md} strokeWidth={icon.stroke} />,
        onClick: () => openNew('folder'),
      },
    );
  }
  if (folderId && data) {
    const own = menuFor(data, {
      create: false,
      inAgentFolder: inAgent,
      afterArchive: () =>
        navigate(data.folder_id ? { page: 'folder', id: data.folder_id } : { page: 'knowledge', space: itemScope }),
    });
    if (pageMenu.length && own.length) pageMenu.push('-');
    pageMenu.push(...own);
  } else if (!folderId && scope !== 'shared') {
    if (pageMenu.length) pageMenu.push('-');
    pageMenu.push({
      label: t('knowledge.exportSpace'),
      onClick: () =>
        void exportKnowledge({ type: 'space', space: scope }).catch((caught: unknown) => notify(errorText(caught, t))),
    });
    pageMenu.push({
      label: t('directory.archived'),
      onClick: () => navigate({ page: 'knowledge', space: scope, archived: true }),
    });
  }

  const missing = error instanceof ApiClientError && (error.status === 404 || error.status === 403);
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!canAdd || archived || !Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (!dropping) setDropping(true);
  };

  return (
    <Page
      width="list"
      header={
        <PageHeader
          title={title}
          help={t('knowledge.folderHelp')}
          badge={
            <>
              {archived && <Badge>{t('knowledge.archivedBadge')}</Badge>}
              {data && data.access === 'viewer' && <Badge>{t('knowledge.readOnly')}</Badge>}
              {data?.shared && <Badge>{t('knowledge.isShared')}</Badge>}
            </>
          }
          primary={
            canAdd && target && !archived ? (
              <Button kind="primary" onClick={() => openNew('doc')}>
                <FilePlus size={icon.md} strokeWidth={icon.stroke} />
                {t('knowledge.newDoc')}
              </Button>
            ) : undefined
          }
          menu={pageMenu}
        />
      }
    >
      <div
        className={cx('app-knowledge-drop', dropping && 'is-dropping')}
        onDragOver={onDragOver}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
        }}
        // A row that takes a drop stops it there: the page still lets go of its outline.
        onDropCapture={() => setDropping(false)}
        onDrop={(event) => {
          if (!canAdd || archived || !Array.from(event.dataTransfer.types).includes('Files')) return;
          event.preventDefault();
          upload(Array.from(event.dataTransfer.files));
        }}
      >
        {folderId && data && <Crumbs scope={itemScope} path={data.path} current={data.name} />}
        {data?.agent_id && <p className="app-muted">{t('knowledge.agentFolderHint')}</p>}
        {archived && data && (
          <Banner
            tone="warning"
            action={
              canArchive(data) ? (
                <Button size="sm" onClick={() => void restore(data)}>
                  {t('knowledge.restore')}
                </Button>
              ) : undefined
            }
          >
            {t('knowledge.folderArchived')}
          </Banner>
        )}
        <div className="app-toolbar app-knowledge-toolbar">
          <SearchInput
            label={t('knowledge.searchIn', { name: title })}
            placeholder={t('knowledge.searchIn', { name: title })}
            value={q}
            onChange={setQ}
          />
          {!debounced && (
            <>
              <Select
                label={t('knowledge.sort')}
                value={sort}
                options={SORTS.map((value) => ({ value, label: t(`knowledge.sort.${value}`) }))}
                onChange={(value) => {
                  setSort(value as Sort);
                  store('knowledge-sort', value);
                }}
              />
              <Segmented
                label={t('knowledge.view')}
                items={[
                  { value: 'list', label: t('knowledge.viewList') },
                  { value: 'grid', label: t('knowledge.viewGrid') },
                ]}
                value={view}
                onChange={(value) => {
                  setView(value as View);
                  store('knowledge-view', value);
                }}
              />
            </>
          )}
        </div>
        <UploadList items={uploads.items} onRetry={uploads.retry} onDismiss={uploads.dismiss} />
        {dropping && <p className="app-knowledge-drop-hint">{t('knowledge.dropHere', { name: title })}</p>}
        {debounced ? (
          search.isPending ? (
            <Skeleton lines={4} />
          ) : search.isError ? (
            <ErrorBox onRetry={() => void search.refetch()}>{errorText(search.error, t)}</ErrorBox>
          ) : search.items.length ? (
            <SearchResults hits={search.items} />
          ) : (
            <Empty
              icon={<Search />}
              title={t('knowledge.noMatch', { query: debounced })}
              action={<Button onClick={() => setQ('')}>{t('knowledge.clearSearch')}</Button>}
            />
          )
        ) : loading ? (
          <Skeleton lines={6} />
        ) : missing ? (
          <Empty
            icon={<FolderOpen />}
            title={t('knowledge.folderMissing')}
            description={t('knowledge.docMissingHint')}
          />
        ) : error ? (
          <ErrorBox onRetry={() => void (folderId ? folder.refetch() : roots.refetch())}>
            {errorText(error, t)}
          </ErrorBox>
        ) : !sorted.length ? (
          <Empty
            icon={scope === 'shared' && !folderId ? <Users /> : <Inbox />}
            title={
              folderId
                ? t('knowledge.emptyFolder')
                : scope === 'shared'
                  ? t('knowledge.nothingShared')
                  : scope === 'team'
                    ? t('knowledge.emptyTeam')
                    : t('knowledge.emptyMine')
            }
            action={
              canAdd && target && !archived ? (
                <Button onClick={() => openNew('doc')}>{t('knowledge.newDoc')}</Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <ul className={view === 'grid' ? 'app-knowledge-grid' : 'app-list'} aria-label={title}>
              {sorted.map((item) => (
                <ItemRow
                  key={itemKey(item)}
                  item={item}
                  view={view}
                  menu={menuFor(item, { inAgentFolder: inAgent, ...(orderable ? { siblings: sorted } : {}) })}
                  dnd={{
                    ...dnd.source(item),
                    ...dnd.target(item, orderable && oneFolder(sorted) ? sorted : undefined),
                  }}
                  dropAt={dnd.over?.key === itemKey(item) ? dnd.over.position : null}
                />
              ))}
            </ul>
            {list.hasNextPage && (
              <div className="app-knowledge-more">
                <Button kind="ghost" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                  {t('knowledge.showMore')}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      {canAdd && uploadTarget && (
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          aria-label={t('knowledge.upload')}
          onChange={(event) => {
            upload(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
      )}
      {file && <FilePreview id={file} onClose={closePreview} />}
    </Page>
  );
}
