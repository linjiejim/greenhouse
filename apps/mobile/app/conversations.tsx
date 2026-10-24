/**
 * 全部对话 — a sheet over home: my conversations, pinned first (swipe to pin, long press to
 * rename), the ones the phone keeps showing at once. The native search bar searches every
 * conversation I can read on the station (`/api/search?kind=session`). A conversation opens its
 * page (the sheet closes first).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { searchAll } from '../src/api/assistant';
import { ConversationRow } from '../src/chat/conversation-row';
import { useT } from '../src/lib/i18n';
import type { ChatSession } from '../src/shared/greenhouse-types';
import { useOpenObject } from '../src/shell/open-object';
import { useSessions } from '../src/store/sessions';
import { makeStyles, space, typo, useTheme } from '../src/theme';
import { promptText } from '../src/ui/dialogs';
import { DirectorySearch, useDirectoryFilter } from '../src/ui/directory-search';
import { EmptyState } from '../src/ui/empty';
import { Skeleton } from '../src/ui/skeleton';
import { Row, rowPosition } from '../src/ui/list';
import { SheetScreen } from '../src/ui/screen';

export default function Conversations() {
  const t = useT();
  const router = useRouter();
  const openObject = useOpenObject();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const sessions = useSessions((s) => s.items);
  const status = useSessions((s) => s.status);
  const offline = useSessions((s) => s.offline);
  const filter = useDirectoryFilter();
  const query = filter.query.trim();
  const [hits, setHits] = useState<{ id: string; title: string; subtitle?: string }[] | null>(null);

  useEffect(() => {
    void useSessions.getState().refresh();
  }, []);

  useEffect(() => {
    if (!query) {
      setHits(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void searchAll(query, 'session').then((result) => {
        if (!alive) return;
        const group = result.ok ? result.data.groups.find((g) => g.kind === 'session') : undefined;
        setHits(
          (group?.items ?? []).flatMap((item) => (item.sessionId ? [{ id: item.sessionId, title: item.title, subtitle: item.subtitle ?? undefined }] : [])),
        );
      });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query]);

  // the conversation is a page: it opens on the stack under this sheet, which closes first
  const open = (id: string) => openObject({ kind: 'chat', sessionId: id });
  const rename = async (session: ChatSession) => {
    const next = await promptText({ title: t('home.rename'), defaultValue: session.title ?? '' });
    if (next) void useSessions.getState().rename(session.id, next.slice(0, 200));
  };
  const empty = useMemo(
    () =>
      status === 'empty' ? (
        <Skeleton rows={8} />
      ) : status === 'error' ? (
        <EmptyState icon="alert" title={t('assistant.loadFailed')} onRetry={() => void useSessions.getState().refresh()} style={styles.state} />
      ) : (
        <EmptyState icon="msgs" title={t(hits ? 'common.noMatches' : 'assistant.empty')} style={styles.state} />
      ),
    [status, hits, styles.state, t],
  );

  return (
    <>
      <SheetScreen title={t('home.allTitle')} actions={[{ icon: 'compose', label: t('assistant.newChat'), onPress: () => { router.back(); setTimeout(() => router.push('/chat'), 0); } }]} />
      <DirectorySearch filter={filter} />
      {hits ? (
        <FlatList
          style={styles.root}
          contentInsetAdjustmentBehavior="automatic"
          data={hits}
          keyExtractor={(hit) => hit.id}
          renderItem={({ item, index }) => (
            <Row
              title={item.title || t('assistant.untitled')}
              subtitle={item.subtitle}
              leading={null}
              position={rowPosition(index, hits.length)}
              onPress={() => open(item.id)}
            />
          )}
          ListEmptyComponent={empty}
          contentContainerStyle={styles.content}
        />
      ) : (
        <FlatList
          style={styles.root}
          contentInsetAdjustmentBehavior="automatic"
          data={sessions}
          keyExtractor={(session) => session.id}
          ListHeaderComponent={offline ? <Text style={styles.offline}>{t('common.savedCopy')}</Text> : null}
          renderItem={({ item, index }) => (
            <ConversationRow
              session={item}
              position={rowPosition(index, sessions.length)}
              onOpen={() => open(item.id)}
              onPin={(pinned) => void useSessions.getState().pin(item.id, pinned)}
              onRename={() => void rename(item)}
            />
          )}
          refreshing={false}
          onRefresh={() => void useSessions.getState().refresh()}
          ListEmptyComponent={empty}
          contentContainerStyle={styles.content}
        />
      )}
    </>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingTop: space.sm, paddingBottom: space.xxxl },
  state: { paddingTop: space.xxxl },
  offline: { ...typo.footnote, color: c.secondaryLabel, marginHorizontal: space.margin + space.xs, marginBottom: space.sm },
}));
