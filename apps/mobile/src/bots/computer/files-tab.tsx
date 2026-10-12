/**
 * One Agent's computer's files (its sandbox, home /home/agent): start in ~/work,
 * open folders, go up to ~; a file opens the shared native preview after an authenticated cache download;
 * sharing/saving is a secondary action. Read-only on the phone
 * (spec D4): a file the member wants on the computer goes in as a chat
 * attachment, which the Agent copies over itself.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Text } from 'react-native';
import { computerFilePath, listComputerFiles } from '../../api/bots';
import { useT } from '../../lib/i18n';
import { formatBytes, relativeTime } from '../../lib/format';
import { saveFile } from '../../chat/file-card';
import type { ComputerFileEntry, ComputerFileList } from '../../shared/bots';
import { makeStyles, space, typo, useTheme } from '../../theme';
import { EmptyState, LoadingState } from '../../ui/empty';
import { ListSection, ListRow } from '../../ui/list';
import { computerErrorKey } from './errors';
import { homePath, parentPath } from './model';
import type { ComputerBot } from './target';

/** `bot`: whose computer (null = the main Agent's). */
export function FilesTab({ bot }: { bot: ComputerBot }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const [path, setPath] = useState<string | undefined>(undefined);
  const [list, setList] = useState<ComputerFileList | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (target: string | undefined) => {
      const result = await listComputerFiles(target, bot);
      if (result.ok) {
        setList(result.value);
        setFailed(null);
      } else {
        setFailed(t(computerErrorKey(result.code) ?? 'bots.computer.filesLoadFailed'));
      }
    },
    [t, bot],
  );

  useEffect(() => {
    void load(path);
  }, [load, path]);

  const open = (entry: ComputerFileEntry) => {
    if (!list) return;
    const full = `${list.path}/${entry.name}`;
    if (entry.type === 'dir') {
      setList(null);
      setPath(full);
      return;
    }
    saveFile(computerFilePath(full, bot), entry.name);
  };

  if (!list) {
    return failed ? (
      <EmptyState icon="alertCircle" title={failed} onRetry={() => void load(path)} style={styles.fill} />
    ) : (
      <LoadingState style={styles.fill} />
    );
  }
  const up = parentPath(list.path);
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
        {homePath(list.path)}
      </Text>
      <ListSection
        footer={
          list.truncated
            ? t('bots.computer.filesTruncated', { count: list.entries.length })
            : t('bots.computer.filesHint')
        }
      >
        {up ? (
          <ListRow
            title={t('bots.computer.filesUp')}
            icon="up"
            iconTint={c.secondaryLabel}
            onPress={() => {
              setList(null);
              setPath(up);
            }}
          />
        ) : null}
        {list.entries.length === 0 ? (
          <ListRow title={t('bots.computer.filesEmpty')} disabled accessory="none" />
        ) : (
          list.entries.map((entry) => (
            <ListRow
              key={entry.name}
              title={entry.name}
              titleLines={2}
              subtitle={
                entry.type === 'dir'
                  ? relativeTime(entry.mtime)
                  : `${formatBytes(entry.size)} · ${relativeTime(entry.mtime)}`
              }
              icon={entry.type === 'dir' ? 'folder' : 'file'}
              accessory="chevron"
              disabled={entry.type === 'other'}
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
