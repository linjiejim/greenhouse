/**
 * The actions of a folder, doc or file — one list for a directory row's right-click menu, a list
 * row's "⋯" and the page's own "⋯" (patterns.md, 右键菜单): the new-item actions, rename, move,
 * share, export, copy link, then archive after a separator. Archiving is undone from its toast.
 */

import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Download,
  Eye,
  FilePlus,
  FolderInput,
  FolderPlus,
  Link2,
  NotebookText,
  Pencil,
  Share2,
  Upload,
  type LucideIcon,
} from 'lucide-react';
import type { MenuEntry } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { KnowledgeItem } from '@greenhouse/contract';
import { useNotify } from '../../app/notify';
import { exportKnowledge, useKnowledgeActions } from '../../data/knowledge';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { href, navigate } from '../../lib/router';
import { useOpenOverlay } from '../../shell/overlays';
import { canArchive, canEdit, canMove, canShare, reorderAround, routeOf } from './helpers';
import { MoveDialog } from './MoveDialog';
import { RenameDialog, useRenameItem } from './RenameDialog';
import { ShareDialog } from './ShareDialog';

const glyph = (Icon: LucideIcon) => <Icon size={icon.md} strokeWidth={icon.stroke} />;

export function useItemMenu() {
  const { t } = useI18n();
  const notify = useNotify();
  const openOverlay = useOpenOverlay();
  const actions = useKnowledgeActions();
  const rename = useRenameItem();

  const fail = (error: unknown) => notify(errorText(error, t));

  const archive = (item: KnowledgeItem, after?: () => void) =>
    actions.archive
      .mutateAsync(item)
      .then(() => {
        after?.();
        notify(t('knowledge.archived', { name: item.name }), {
          label: t('row.undo'),
          onClick: () => actions.restore.mutate(item, { onError: fail }),
        });
      })
      .catch(fail);

  const restore = (item: KnowledgeItem) =>
    actions.restore
      .mutateAsync(item)
      .then(() => notify(t('knowledge.restored', { name: item.name })))
      .catch(fail);

  const copyLink = (item: KnowledgeItem) => {
    void navigator.clipboard?.writeText(`${location.origin}${location.pathname}${href(routeOf(item))}`);
    notify(t('row.linkCopied'));
  };

  const download = (item: KnowledgeItem) =>
    void api.knowledge.files
      .get(item.id)
      .then((file) => {
        const link = document.createElement('a');
        link.href = file.url;
        link.download = file.name;
        link.click();
      })
      .catch(fail);

  /** One place up or down in its folder's hand order. */
  const nudge = (item: KnowledgeItem, siblings: readonly KnowledgeItem[], step: -1 | 1) => {
    const at = siblings.findIndex((other) => other.type === item.type && other.id === item.id);
    const target = siblings[at + step];
    if (!target) return;
    actions.reorder.mutate(
      {
        folder_id: item.folder_id,
        ...(item.folder_id ? {} : { space: item.space }),
        items: reorderAround(siblings, item, target, step < 0 ? 'before' : 'after'),
      },
      { onError: fail },
    );
  };

  const exportIt = (item: KnowledgeItem) =>
    void exportKnowledge(item.type === 'doc' ? { type: 'doc', id: item.id } : { type: 'folder', id: item.id }).catch(
      fail,
    );

  const openNew = (kind: 'doc' | 'folder' | 'upload', folder: KnowledgeItem) =>
    openOverlay({
      type: 'new-knowledge',
      kind,
      target: { space: folder.space, folderId: folder.id, folderName: folder.name },
    });

  /**
   * The menu of one item. `onRename` renames in place (directory rows); without it a dialog asks.
   * `afterArchive` runs once it is archived (a page leaves for the folder above). A page that
   * offers new items and downloads itself leaves them out (`create`, `download`).
   */
  function menuFor(
    item: KnowledgeItem,
    options: {
      onRename?: () => void;
      afterArchive?: () => void;
      open?: boolean;
      create?: boolean;
      download?: boolean;
      /**
       * The rows of its folder in hand order: 上移 / 下移, the keyboard's way to reorder. Only where
       * the folder (or space root) may be put in order: never 分享给我, never a read-only folder.
       */
      siblings?: readonly KnowledgeItem[];
      /** It sits in an Agent's private folder, which nothing in is shared. */
      inAgentFolder?: boolean;
    } = {},
  ): MenuEntry[] {
    if (item.archived_at) {
      return [
        ...(options.open
          ? [{ label: t('knowledge.open'), icon: glyph(Eye), onClick: () => navigate(routeOf(item)) }]
          : []),
        ...(canArchive(item)
          ? [{ label: t('knowledge.restore'), icon: glyph(ArchiveRestore), onClick: () => void restore(item) }]
          : []),
      ];
    }
    const editable = canEdit(item);
    const entries: MenuEntry[] = [];
    if (options.open)
      entries.push({ label: t('knowledge.open'), icon: glyph(Eye), onClick: () => navigate(routeOf(item)) });
    if (item.type === 'folder' && editable && options.create !== false) {
      entries.push(
        { label: t('knowledge.newDoc'), icon: glyph(FilePlus), onClick: () => openNew('doc', item) },
        { label: t('knowledge.upload'), icon: glyph(Upload), onClick: () => openNew('upload', item) },
        { label: t('knowledge.newFolder'), icon: glyph(FolderPlus), onClick: () => openNew('folder', item) },
        '-',
      );
    }
    if (item.type === 'file' && options.download !== false) {
      entries.push({ label: t('knowledge.download'), icon: glyph(Download), onClick: () => download(item) });
    }
    if (editable) {
      entries.push({
        label: t('row.rename'),
        icon: glyph(Pencil),
        onClick: () =>
          options.onRename
            ? options.onRename()
            : openOverlay({ type: 'custom', render: (close) => <RenameDialog item={item} onClose={close} /> }),
      });
    }
    if (canMove(item)) {
      entries.push({
        label: t('knowledge.move'),
        icon: glyph(FolderInput),
        onClick: () => openOverlay({ type: 'custom', render: (close) => <MoveDialog item={item} onClose={close} /> }),
      });
    }
    const together = options.siblings?.filter(
      (other) => other.folder_id === item.folder_id && other.space === item.space && other.owner_id === item.owner_id,
    );
    const at = together?.findIndex((other) => other.type === item.type && other.id === item.id) ?? -1;
    if (together && together.length === options.siblings?.length && at >= 0) {
      if (at > 0)
        entries.push({ label: t('knowledge.moveUp'), icon: glyph(ArrowUp), onClick: () => nudge(item, together, -1) });
      if (at < together.length - 1)
        entries.push({
          label: t('knowledge.moveDown'),
          icon: glyph(ArrowDown),
          onClick: () => nudge(item, together, 1),
        });
    }
    if (item.type !== 'file' && canShare(item) && !options.inAgentFolder) {
      entries.push({
        label: t('knowledge.share'),
        icon: glyph(Share2),
        onClick: () =>
          openOverlay({
            type: 'custom',
            render: (close) => (
              <ShareDialog type={item.type as 'folder' | 'doc'} id={item.id} name={item.name} onClose={close} />
            ),
          }),
      });
    }
    if (item.type !== 'file') {
      entries.push({
        label: item.type === 'doc' ? t('row.export') : t('knowledge.exportZip'),
        icon: glyph(Download),
        onClick: () => exportIt(item),
      });
    }
    if (item.type === 'doc' && editable) {
      entries.push({
        label: item.is_template ? t('knowledge.unmarkTemplate') : t('knowledge.markTemplate'),
        icon: glyph(NotebookText),
        onClick: () =>
          actions.updateDoc.mutate({ id: item.id, input: { is_template: !item.is_template } }, { onError: fail }),
      });
    }
    entries.push({ label: t('row.copyLink'), icon: glyph(Link2), onClick: () => copyLink(item) });
    if (canArchive(item)) {
      entries.push('-', {
        label: t('row.archive'),
        icon: glyph(Archive),
        onClick: () => void archive(item, options.afterArchive),
      });
    }
    return entries;
  }

  return { menuFor, rename, archive, restore, download };
}
