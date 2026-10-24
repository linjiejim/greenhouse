/**
 * Move — the folder picker sheet a row's long-press menu opens (`/move?k=`, the item handed over
 * through src/lib/handoff.ts): the shelf's folders one level at a time under a path bar, and
 * 移到这里 to put the document, file or folder in the level on screen. A folder can't go into
 * itself or below itself, and nothing leaves its shelf (the server refuses cross-shelf moves).
 */

import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, Text } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { listFolders, updateFile, updateFolder } from '../src/api/drive';
import { updateDoc } from '../src/api/knowledge';
import type { ApiResult } from '../src/api/client';
import { pathTo } from '../src/data/kb-tree';
import { useResource } from '../src/data/use-resource';
import { getHandoff } from '../src/lib/handoff';
import { useT } from '../src/lib/i18n';
import type { Movable } from '../src/library/changes';
import { PathBar } from '../src/library/path-bar';
import { useLibraryActions } from '../src/library/use-library-actions';
import type { DriveFolder } from '../src/shared/greenhouse-types';
import { makeStyles, space, typo, useTheme } from '../src/theme';
import { NativeButton } from '../src/ui/button';
import { EmptyState, LoadingState } from '../src/ui/empty';
import { Row, rowPosition } from '../src/ui/list';
import { SheetScreen } from '../src/ui/screen';
import { SheetActions } from '../src/ui/sheet-actions';

/** The folder and everything under it (where a folder may not move). */
function subtree(folders: readonly DriveFolder[], rootId: number): Set<number> {
  const out = new Set<number>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of folders) {
      if (folder.parent_id != null && out.has(folder.parent_id) && !out.has(folder.id)) {
        out.add(folder.id);
        grew = true;
      }
    }
  }
  return out;
}

export default function Move() {
  const { k } = useLocalSearchParams<{ k?: string }>();
  const item = getHandoff<Movable>(k, 'move');
  const t = useT();
  const router = useRouter();
  const actions = useLibraryActions();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const [level, setLevel] = useState<number | null>(null);
  const [moving, setMoving] = useState(false);
  const resource = useResource(useCallback(() => listFolders(item?.shelf ?? 'team'), [item?.shelf]));
  const folders = useMemo(() => resource.data?.folders ?? [], [resource.data]);
  const blocked = useMemo(() => (item?.kind === 'folder' ? subtree(folders, item.id) : new Set<number>()), [folders, item]);
  const here = folders.filter((f) => (f.parent_id ?? null) === level && !blocked.has(f.id)).sort((a, b) => a.name.localeCompare(b.name));
  const path = pathTo(folders, level);

  if (!item) {
    return (
      <>
        <SheetScreen title={t('library.move')} />
        <EmptyState icon="folder" title={t('chat.expired')} style={styles.state} />
      </>
    );
  }

  const move = async () => {
    setMoving(true);
    const done = await actions.run<unknown>(
      (): Promise<ApiResult<unknown>> =>
        item.kind === 'doc'
          ? updateDoc(item.id, { folderId: level })
          : item.kind === 'file'
            ? updateFile(item.id, { folderId: level })
            : updateFolder(item.id, { parentId: level }),
      t('library.moveFailed'),
      t('library.moved'),
    );
    setMoving(false);
    if (done !== null) router.back();
  };

  return (
    <>
      <SheetScreen title={t('library.moveTitle', { name: item.name })} />
      <FlatList<DriveFolder>
        style={styles.root}
        contentInsetAdjustmentBehavior="automatic"
        data={here}
        keyExtractor={(folder) => String(folder.id)}
        ListHeaderComponent={
          <PathBar
            levels={[t(item.shelf === 'personal' ? 'files.shelf.personal' : 'files.shelf.team'), ...path.map((f) => f.name)]}
            onPick={(index) => setLevel(index === 0 ? null : path[index - 1]!.id)}
          />
        }
        renderItem={({ item: folder, index }) => (
          <Row title={folder.name} icon="folder" accessory="chevron" position={rowPosition(index, here.length)} onPress={() => setLevel(folder.id)} />
        )}
        ListEmptyComponent={
          resource.loading && !resource.data ? (
            <LoadingState style={styles.state} />
          ) : (
            <Text style={styles.hint}>{t('library.noSubfolders')}</Text>
          )
        }
        contentContainerStyle={styles.content}
      />
      <SheetActions>
        <NativeButton label={t('library.moveHere')} variant="prominent" size="large" fullWidth loading={moving} disabled={!resource.data} onPress={() => void move()} />
      </SheetActions>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingBottom: space.xxxl },
  state: { paddingTop: space.xxxl },
  hint: { ...typo.subheadline, color: c.secondaryLabel, textAlign: 'center', marginTop: space.xl },
}));
