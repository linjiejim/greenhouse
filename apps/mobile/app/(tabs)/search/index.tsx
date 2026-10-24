/**
 * 搜索 — the system search tab (iOS 26 puts its field in the tab bar): one query across
 * conversations, documents, projects (the station's search), 云盘 files and my tasks (kept on
 * the phone, so they are found offline too). Rules in src/data/search.ts. A hit opens as its
 * sheet, a conversation as its page.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { SectionList, Text } from 'react-native';
import { Stack } from 'expo-router';
import { searchAll } from '../../../src/api/assistant';
import { searchCabinet } from '../../../src/api/drive';
import { parseMyTasks } from '../../../src/data/recent-items';
import { fileSection, stationSections, taskSection, type SearchHitView, type SearchSection } from '../../../src/data/search';
import { formatBytes } from '../../../src/lib/format';
import { useT, type TranslationKey } from '../../../src/lib/i18n';
import { useOpenObject } from '../../../src/shell/open-object';
import { readOffline } from '../../../src/store/offline';
import { makeStyles, space, typo, useTheme } from '../../../src/theme';
import type { IconName } from '../../../src/ui/core';
import { EmptyState, LoadingState } from '../../../src/ui/empty';
import { FileIcon } from '../../../src/ui/file-icon';
import { LIST_TILE, Row, SectionHeader, rowPosition } from '../../../src/ui/list';

const TITLE: Record<SearchSection['kind'], TranslationKey> = {
  session: 'search.conversations',
  kb_doc: 'search.docs',
  project: 'search.projects',
  file: 'search.files',
  task: 'search.tasks',
  other: 'search.other',
};

const ICON: Record<SearchSection['kind'], IconName> = {
  session: 'msg',
  kb_doc: 'file',
  project: 'checklist',
  file: 'fileOther',
  task: 'checkCircle',
  other: 'search',
};

export default function Search() {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const openObject = useOpenObject();
  const [query, setQuery] = useState('');
  const [sections, setSections] = useState<SearchSection[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const q = query.trim();

  useEffect(() => {
    if (!q) {
      setSections(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      setSearching(true);
      void Promise.all([searchAll(q), searchCabinet(q), readOffline('my-tasks')]).then(([station, files, saved]) => {
        if (!alive) return;
        setFailed(!station.ok && !files.ok);
        const tasks = (parseMyTasks(saved) ?? []).flatMap((group) => group.tasks);
        setSections(
          [
            ...(station.ok ? stationSections(station.data.groups) : []),
            files.ok ? fileSection(files.data.files, (size) => (size != null ? formatBytes(size) : '')) : null,
            taskSection(tasks, q),
          ].filter((section): section is SearchSection => !!section),
        );
        setSearching(false);
      });
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q]);

  const data = useMemo(() => (sections ?? []).map((section) => ({ ...section, data: section.hits })), [sections]);

  return (
    <>
      <Stack.Screen options={{ title: t('common.search') }} />
      <Stack.SearchBar
        placeholder={t('search.placeholder')}
        onChangeText={(event) => setQuery(event.nativeEvent.text)}
        onCancelButtonPress={() => setQuery('')}
      />
      <SectionList<SearchHitView, SearchSection & { data: SearchHitView[] }>
        style={styles.root}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        sections={data}
        keyExtractor={(hit) => hit.key}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => <SectionHeader title={t(TITLE[section.kind])} style={styles.header} />}
        renderItem={({ item, index, section }) => (
          <Row
            title={item.title}
            subtitle={item.subtitle || undefined}
            icon={section.kind === 'file' ? undefined : ICON[section.kind]}
            leading={section.kind === 'file' ? <FileIcon tile size={17} name={item.fileName ?? item.title} /> : undefined}
            leadingWidth={LIST_TILE}
            accessory="chevron"
            position={rowPosition(index, section.hits.length)}
            onPress={() => openObject(item.ref)}
          />
        )}
        ListEmptyComponent={
          !q ? (
            <Text style={styles.hint}>{t('search.hint')}</Text>
          ) : searching || !sections ? (
            <LoadingState style={styles.state} />
          ) : failed ? (
            <EmptyState icon="alert" title={t('search.failed')} style={styles.state} />
          ) : (
            <EmptyState icon="search" title={t('common.noMatches')} style={styles.state} />
          )
        }
        contentContainerStyle={styles.content}
      />
    </>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingBottom: space.xxxl },
  header: { marginTop: space.lg },
  hint: { ...typo.subheadline, color: c.secondaryLabel, textAlign: 'center', marginTop: space.xxxl, marginHorizontal: space.xxl },
  state: { paddingTop: space.xxxl },
}));
