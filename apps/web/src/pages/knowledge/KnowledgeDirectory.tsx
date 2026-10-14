/**
 * The knowledge directory (PRD §6.1): the space switch (团队 / 个人 / 分享给我), the folder tree with
 * docs and files in it, and 已归档 at the bottom. Folders open in place (the chevron, or the arrow
 * keys) and on their own page (the row); every row has the right-click menu of its "⋯", renames
 * in place, and can be dragged into a folder or between rows to put it in order. The directory's
 * search filters the rows it has loaded.
 */

import { useCallback, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Archive } from 'lucide-react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Segmented, Skeleton } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { KnowledgeDoc, KnowledgeFolder, KnowledgeItem, KnowledgeScope } from '@greenhouse/contract';
import { useNotify } from '../../app/notify';
import { useFolder, useKnowledgeRoots } from '../../data/knowledge';
import { keys } from '../../data/query';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { href, type Route } from '../../lib/router';
import { DirectoryRow } from '../../shell/DirectoryRow';
import { useItemMenu } from './actions';
import { useKnowledgeDnd } from './dnd';
import { canEdit, itemKey, matchesName, oneFolder, routeOf } from './helpers';
import type { KnowledgeTarget } from './NewItemDialog';
import { ItemIcon, useSpaceName } from './parts';
import { setKnowledgeScope, toggleFolder, useKnowledgeScope, useOpenFolders } from './scope';
import { useUploads } from './uploads';

/** Made once for the whole tree, not per row: drag and drop, and the rows' menus. */
interface Tools {
  dnd: ReturnType<typeof useKnowledgeDnd>;
  menu: ReturnType<typeof useItemMenu>;
}

/**
 * Where 新建 puts things: the folder on screen (or the folder of the doc on screen) when the member
 * may add to it, else the root of the space the directory shows (mine for 分享给我).
 */
export function useNewTarget(route: Route): () => KnowledgeTarget {
  const client = useQueryClient();
  const scope = useKnowledgeScope();
  return useCallback(() => {
    const root: KnowledgeTarget = { space: scope === 'team' ? 'team' : 'personal' };
    if (route.page === 'knowledge') {
      return route.space === 'team' || route.space === 'personal' ? { space: route.space } : root;
    }
    if (route.page === 'folder') {
      const folder = client.getQueryData<KnowledgeFolder>(keys.knowledgeFolder(route.id));
      return folder && canEdit(folder) ? { space: folder.space, folderId: folder.id, folderName: folder.name } : root;
    }
    if (route.page === 'doc') {
      const doc = client.getQueryData<KnowledgeDoc>(keys.doc(route.id));
      const above = doc?.path[doc.path.length - 1];
      if (doc && doc.access !== 'viewer' && !doc.archived_at) {
        return doc.folder_id && above?.id === doc.folder_id
          ? { space: doc.space, folderId: doc.folder_id, folderName: above.name }
          : doc.folder_id
            ? root
            : { space: doc.space };
      }
    }
    return root;
  }, [client, scope, route]);
}

/** Whether a folder, or anything loaded below it, has a name with the query in it. */
function folderMatches(client: QueryClient, folder: KnowledgeItem, query: string, depth = 0): boolean {
  if (matchesName(folder.name, query)) return true;
  if (depth > 8) return false;
  const loaded = client.getQueryData<KnowledgeFolder>(keys.knowledgeFolder(folder.id));
  return (loaded?.children ?? []).some((child) =>
    child.type === 'folder' ? folderMatches(client, child, query, depth + 1) : matchesName(child.name, query),
  );
}

function current(route: Route): string | null {
  if (route.page === 'doc' || route.page === 'folder') return route.id;
  return null;
}

function TreeRow({
  item,
  siblings,
  depth,
  route,
  query,
  tools,
}: {
  item: KnowledgeItem;
  /** Its folder's rows in order, when they can be put in order together. */
  siblings: KnowledgeItem[] | undefined;
  depth: number;
  route: Route;
  query: string;
  tools: Tools;
}) {
  const { t } = useI18n();
  const notify = useNotify();
  const { menuFor, rename } = tools.menu;
  const { dnd } = tools;
  const open = useOpenFolders();
  const [renaming, setRenaming] = useState(false);
  const isFolder = item.type === 'folder';
  const expanded = isFolder && (open.has(item.id) || !!query);
  const active =
    current(route) === item.id ||
    (route.page === 'folder' && route.file === item.id) ||
    (route.page === 'knowledge' && route.file === item.id);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!isFolder) return;
    if (event.key === 'ArrowRight' && !expanded) {
      event.preventDefault();
      toggleFolder(item.id, true);
    } else if (event.key === 'ArrowLeft' && expanded) {
      event.preventDefault();
      toggleFolder(item.id, false);
    }
  };
  const onClick = (event: MouseEvent<HTMLElement>) => {
    if (!isFolder) return;
    // The chevron opens and closes in place; the rest of the row opens the folder (and its branch).
    if ((event.target as Element).closest('.app-row-chevron')) {
      event.preventDefault();
      toggleFolder(item.id);
    } else if (!expanded) toggleFolder(item.id, true);
  };

  return (
    <>
      <DirectoryRow
        leading={<ItemIcon item={item} size={icon.md} />}
        title={item.name}
        href={href(routeOf(item))}
        active={active}
        indent={depth}
        expanded={isFolder ? expanded : undefined}
        leaf={!isFolder}
        menu={() => menuFor(item, { onRename: () => setRenaming(true), siblings })}
        menuLabel={t('row.actionsFor', { name: item.name })}
        renaming={renaming}
        onRename={(name) => {
          setRenaming(false);
          if (name) void rename(item, name).catch((error: unknown) => notify(errorText(error, t)));
        }}
        onClick={onClick}
        rowProps={{ ...dnd.source(item), ...dnd.target(item, siblings), onKeyDown }}
        dropAt={dnd.over?.key === itemKey(item) ? dnd.over.position : null}
      />
      {isFolder && expanded && <TreeFolder id={item.id} depth={depth + 1} route={route} query={query} tools={tools} />}
    </>
  );
}

function TreeLevel({
  items,
  depth,
  route,
  query,
  tools,
}: {
  items: KnowledgeItem[];
  depth: number;
  route: Route;
  query: string;
  tools: Tools;
}) {
  const client = useQueryClient();
  // 分享给我 lists what several people own: nothing there is put in order together.
  const ordered = oneFolder(items) ? items : undefined;
  const visible = query
    ? items.filter((item) =>
        item.type === 'folder' ? folderMatches(client, item, query) : matchesName(item.name, query),
      )
    : items;
  return (
    <>
      {visible.map((item) => (
        <TreeRow
          key={itemKey(item)}
          item={item}
          siblings={ordered}
          depth={depth}
          route={route}
          query={query}
          tools={tools}
        />
      ))}
    </>
  );
}

function TreeFolder({
  id,
  depth,
  route,
  query,
  tools,
}: {
  id: string;
  depth: number;
  route: Route;
  query: string;
  tools: Tools;
}) {
  const { t } = useI18n();
  const folder = useFolder(id);
  if (folder.isPending)
    return (
      <div className="app-tree-loading" style={{ paddingLeft: `calc(${depth} * var(--gh-space-4))` }}>
        <Skeleton lines={1} />
      </div>
    );
  if (folder.isError) return <p className="app-muted app-directory-note">{errorText(folder.error, t)}</p>;
  const items = folder.data.children;
  if (!items.length && !query) {
    return (
      <p
        className="app-muted app-tree-empty"
        style={{ paddingLeft: `calc(var(--gh-space-8) + ${depth} * var(--gh-space-4))` }}
      >
        {t('knowledge.emptyFolderShort')}
      </p>
    );
  }
  return <TreeLevel items={items} depth={depth} route={route} query={query} tools={tools} />;
}

export function KnowledgeDirectory({ route, query }: { route: Route; query: string }) {
  const { t } = useI18n();
  const notify = useNotify();
  const spaceName = useSpaceName();
  const scope = useKnowledgeScope();
  const roots = useKnowledgeRoots(scope);
  const uploads = useUploads();
  const menu = useItemMenu();
  const dnd = useKnowledgeDnd({
    onFiles: (files, folder) =>
      void uploads.start(files, { folder_id: folder.id }).then((done) => {
        const failed = files.length - done.length;
        notify(
          failed
            ? t('knowledge.uploadSomeFailed', { count: failed })
            : t('knowledge.uploadedInto', { count: done.length, name: folder.name }),
        );
      }),
  });
  const tools: Tools = { dnd, menu };
  const archivedSpace = scope === 'shared' ? null : scope;

  return (
    <>
      <div className="app-knowledge-scope">
        <Segmented
          label={t('knowledge.space')}
          items={(['team', 'personal', 'shared'] as KnowledgeScope[]).map((value) => ({
            value,
            label: spaceName(value),
          }))}
          value={scope}
          onChange={(value) => setKnowledgeScope(value as KnowledgeScope)}
        />
      </div>
      <div className="app-knowledge-tree">
        {roots.isPending ? (
          <Skeleton lines={4} />
        ) : roots.isError ? (
          <p className="app-muted app-directory-note">{errorText(roots.error, t)}</p>
        ) : roots.items.length ? (
          <TreeLevel items={roots.items} depth={0} route={route} query={query} tools={tools} />
        ) : (
          <p className="app-muted app-directory-note">
            {scope === 'shared'
              ? t('knowledge.nothingShared')
              : scope === 'team'
                ? t('knowledge.emptyTeam')
                : t('knowledge.emptyMine')}
          </p>
        )}
      </div>
      {archivedSpace && (
        <div className="app-directory-bottom">
          <DirectoryRow
            leading={<Archive size={icon.md} strokeWidth={icon.stroke} />}
            title={t('directory.archived')}
            href={href({ page: 'knowledge', space: archivedSpace, archived: true })}
            active={route.page === 'knowledge' && !!route.archived && route.space === archivedSpace}
          />
        </div>
      )}
    </>
  );
}
