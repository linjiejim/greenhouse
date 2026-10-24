/**
 * A folder, document or file row of the knowledge base or 云盘, with its system context menu
 * (long press): new subfolder or document in a folder, rename, move, delete, ask the assistant.
 * The same actions are VoiceOver actions on the row. Documents are not deleted from the phone.
 */

import React, { useMemo } from 'react';
import { useRouter } from 'expo-router';
import type { FilesShelf } from '../api/drive';
import { useT } from '../lib/i18n';
import { NativeMenu, menuSections, type MenuItem } from '../ui/menu';
import { FileIcon } from '../ui/file-icon';
import { LIST_TILE, Row, type RowPosition } from '../ui/list';
import type { Movable } from './changes';
import { useLibraryActions } from './use-library-actions';

export type LibraryItem =
  | { kind: 'folder'; id: string; name: string; shelf: FilesShelf; scope: 'kb' | 'drive' }
  | { kind: 'doc'; id: string; name: string; shelf: FilesShelf; subtitle?: string }
  | { kind: 'file'; id: string; name: string; shelf: FilesShelf; subtitle?: string; contentType?: string | null };

/** The question a new conversation starts with when asking about an item (a link the assistant can read). */
function askAbout(item: LibraryItem, prompt: string): string {
  const href =
    item.kind === 'doc'
      ? `#/knowledge/doc/${item.id}`
      : item.kind === 'file'
        ? `#/files?shelf=${item.shelf}&file=${item.id}`
        : `#/files?shelf=${item.shelf}&folder=${item.id}`;
  return `${prompt} [${item.name}](${href})\n\n`;
}

export function LibraryRow({
  item,
  position,
  onPress,
  readOnly = false,
}: {
  item: LibraryItem;
  position: RowPosition;
  onPress: () => void;
  /** Shared with me: only open and ask. */
  readOnly?: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const actions = useLibraryActions();
  const movable: Movable = { kind: item.kind, id: item.id, name: item.name, shelf: item.shelf };

  const items = useMemo((): MenuItem[] => {
    const create: MenuItem[] =
      item.kind === 'folder' && !readOnly
        ? [
            { id: 'newFolder', title: t('library.newFolder'), icon: 'folderPlus' },
            ...(item.scope === 'kb' ? [{ id: 'newDoc', title: t('library.newDoc'), icon: 'docPlus' } as MenuItem] : []),
          ]
        : [];
    const edit: MenuItem[] = readOnly
      ? []
      : [
          { id: 'rename', title: t('library.rename'), icon: 'pen' },
          { id: 'move', title: t('library.move'), icon: 'moveTo' },
        ];
    const remove: MenuItem[] =
      readOnly || item.kind === 'doc' ? [] : [{ id: 'delete', title: t('library.delete'), icon: 'trash', destructive: true }];
    return menuSections([create, edit, [{ id: 'ask', title: t('library.ask'), icon: 'sparkle' }], remove]);
  }, [item, readOnly, t]);

  const select = (id: string) => {
    if (id === 'newFolder') void actions.newFolder(item.shelf, item.id);
    else if (id === 'newDoc') actions.newDoc(item.shelf, item.id);
    else if (id === 'rename') void actions.rename(movable);
    else if (id === 'move') actions.move(movable);
    else if (id === 'delete') void actions.remove(movable);
    else if (id === 'ask') router.push({ pathname: '/chat', params: { draft: askAbout(item, t('library.askPrompt')) } });
  };

  const flat = items.flatMap((group) => group.children ?? [group]);
  return (
    <NativeMenu trigger="longPress" items={items} onSelect={select}>
      <Row
        title={item.name}
        titleEllipsize={item.kind === 'file' ? 'middle' : 'tail'}
        subtitle={item.kind === 'folder' ? undefined : item.subtitle}
        icon={item.kind === 'folder' ? 'folder' : undefined}
        leading={
          item.kind === 'doc' ? (
            <FileIcon tile size={17} kind="doc" />
          ) : item.kind === 'file' ? (
            <FileIcon tile size={17} name={item.name} contentType={item.contentType} />
          ) : undefined
        }
        leadingWidth={LIST_TILE}
        accessory={item.kind === 'folder' ? 'chevron' : 'none'}
        position={position}
        onPress={onPress}
        accessibilityActions={flat.map((entry) => ({ name: entry.id, label: entry.title }))}
        onAccessibilityAction={(event) => select(event.nativeEvent.actionName)}
      />
    </NativeMenu>
  );
}
