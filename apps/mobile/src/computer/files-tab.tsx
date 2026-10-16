/**
 * The files in an Agent's computer's home (AGNT-18): open folders, go up to the home, open a
 * file in the shared native preview (an authenticated download, then Quick Look; sharing and
 * saving from there). Uploading and deleting stay on the web in this phase.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Text } from 'react-native';
import { computerFilePath, computerFiles } from '../api/computer';
import { saveFile } from '../chat/file-card';
import { formatBytes } from '../lib/format';
import { useT } from '../lib/i18n';
import { relativeTimeNow } from '../lib/time-words';
import type { ComputerFile, ComputerFolder } from '../shared/contract';
import { makeStyles, space, typo, useTheme } from '../theme';
import { EmptyState, LoadingState } from '../ui/empty';
import { ListRow, ListSection } from '../ui/list';

const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
const parent = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

export function FilesTab({ agentId }: { agentId: string }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const [path, setPath] = useState('');
  const [folder, setFolder] = useState<ComputerFolder | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (target: string) => {
      const result = await computerFiles(agentId, target);
      if (result.ok) {
        setFolder(result.data);
        setFailed(null);
      } else setFailed(result.message || t('computer.filesFailed'));
    },
    [agentId, t],
  );

  useEffect(() => {
    void load(path);
  }, [load, path]);

  const open = (entry: ComputerFile) => {
    if (!folder) return;
    const full = join(folder.path, entry.name);
    if (entry.type === 'dir') {
      setFolder(null);
      setPath(full);
      return;
    }
    saveFile(computerFilePath(agentId, full), entry.name);
  };

  if (!folder) {
    return failed ? (
      <EmptyState icon="alertCircle" title={failed} onRetry={() => void load(path)} style={styles.fill} />
    ) : (
      <LoadingState style={styles.fill} />
    );
  }
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="never"
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void load(path).finally(() => setRefreshing(false));
          }}
        />
      }
    >
      <Text style={styles.path} numberOfLines={1} ellipsizeMode="head" selectable>
        {folder.path ? `~/${folder.path}` : '~'}
      </Text>
      <ListSection footer={folder.truncated ? t('computer.filesTruncated', { n: folder.items.length }) : undefined}>
        {folder.path ? (
          <ListRow
            title={t('computer.filesUp')}
            icon="up"
            iconTint={c.secondaryLabel}
            onPress={() => {
              setFolder(null);
              setPath(parent(folder.path));
            }}
          />
        ) : null}
        {folder.items.length === 0 ? (
          <ListRow title={t('computer.filesEmpty')} disabled accessory="none" />
        ) : (
          folder.items.map((entry) => (
            <ListRow
              key={entry.name}
              title={entry.name}
              titleLines={2}
              subtitle={
                entry.type === 'dir'
                  ? relativeTimeNow(entry.modified_at)
                  : `${formatBytes(entry.size)} · ${relativeTimeNow(entry.modified_at)}`
              }
              icon={entry.type === 'dir' ? 'folder' : 'file'}
              accessory="chevron"
              onPress={() => open(entry)}
            />
          ))
        )}
      </ListSection>
    </ScrollView>
  );
}

const useStyles = makeStyles((c) => ({
  fill: { flex: 1, justifyContent: 'center' },
  content: { paddingTop: space.md, paddingBottom: space.xxxl },
  path: { ...typo.footnote, color: c.secondaryLabel, marginHorizontal: space.margin * 2, marginBottom: space.sm },
}));
