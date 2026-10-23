/**
 * Assistant (助手): my conversations with the in-app assistant, newest first, and a compose button
 * for a new one. Light by design — the full chat with agents and tools lives on the web.
 */

import React, { useCallback, useState } from 'react';
import { FlatList, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { createSession, listSessions } from '../../src/api/assistant';
import { captureIdentity } from '../../src/data/identity';
import { useResource } from '../../src/data/use-resource';
import { useT } from '../../src/lib/i18n';
import { relativeTimeNow } from '../../src/lib/time-words';
import type { ChatSession } from '../../src/shared/greenhouse-types';
import { makeStyles, space, useTheme } from '../../src/theme';
import { alertError } from '../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { ListRow, type RowPosition } from '../../src/ui/list';
import { toolbarIcon } from '../../src/ui/toolbar-icon';

export default function Assistant() {
  const t = useT();
  const router = useRouter();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const load = useCallback(async () => {
    const result = await listSessions();
    return result.ok ? { ok: true as const, data: result.data.sessions } : result;
  }, []);
  const resource = useResource(load);
  const sessions = resource.data ?? [];
  const [starting, setStarting] = useState(false);

  const start = async () => {
    if (starting) return;
    const current = captureIdentity();
    setStarting(true);
    const result = await createSession();
    setStarting(false);
    if (!current()) return;
    if (!result.ok) {
      alertError(t('assistant.sendFailed'), result.message || undefined);
      return;
    }
    router.push({ pathname: '/assistant/chat', params: { session: result.data.id } });
  };

  const position = (index: number): RowPosition =>
    sessions.length === 1 ? 'only' : index === 0 ? 'first' : index === sessions.length - 1 ? 'last' : 'middle';

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: t('nav.assistant') }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={toolbarIcon('compose')}
          accessibilityLabel={t('assistant.newChat')}
          disabled={starting}
          onPress={() => void start()}
        />
      </Stack.Toolbar>
      <FlatList<ChatSession>
        contentInsetAdjustmentBehavior="automatic"
        data={sessions}
        keyExtractor={(session) => session.id}
        refreshing={resource.loading && !!resource.data}
        onRefresh={() => void resource.refresh()}
        renderItem={({ item, index }) => (
          <ListRow
            title={item.title?.trim() || t('assistant.untitled')}
            subtitle={relativeTimeNow(item.updated_at)}
            icon="msg"
            accessory="chevron"
            position={position(index)}
            onPress={() => router.push({ pathname: '/assistant/chat', params: { session: item.id } })}
          />
        )}
        ListEmptyComponent={
          !resource.data ? (
            resource.loading ? (
              <LoadingState style={styles.state} />
            ) : (
              <EmptyState icon="alert" title={t('assistant.loadFailed')} onRetry={() => void resource.refresh()} style={styles.state} />
            )
          ) : (
            <EmptyState icon="msgs" title={t('assistant.empty')} message={t('assistant.emptyHint')} style={styles.state} />
          )
        }
        contentContainerStyle={styles.content}
      />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingTop: space.md, paddingBottom: space.xxxl },
  state: { paddingTop: space.xxxl },
}));
