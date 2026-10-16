import { useCallback, useEffect } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter, useIsFocused } from 'expo-router';
import { doc, heartbeat, leaveDoc, presence } from '../../src/api/knowledge';
import { useResource } from '../../src/data/use-resource';
import { Markdown } from '../../src/chat/markdown';
import { Comments } from '../../src/knowledge/comments';
import { ResourceState } from '../../src/knowledge/state';
import { putHandoff } from '../../src/lib/handoff';
import { useT } from '../../src/lib/i18n';
import { toolbarIcon } from '../../src/ui/toolbar-icon';
import { ListSection, ListRow } from '../../src/ui/list';
import { makeStyles, space, typo, useTheme } from '../../src/theme';
export default function Doc() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const t = useT();
  const router = useRouter();
  const { colors: c } = useTheme();
  const s = useStyles(c);
  const focused = useIsFocused();
  const resource = useResource(
    useCallback(() => doc(id), [id]),
    ['knowledge.changed', 'doc.updated', 'comments.updated'],
  );
  const others = useResource(
    useCallback(() => presence(id), [id]),
    ['doc.presence'],
  );
  const refreshPresence = others.refresh;
  useEffect(() => {
    if (!focused) return;
    void heartbeat(id);
    const timer = setInterval(() => {
      void heartbeat(id);
      void refreshPresence();
    }, 20000);
    return () => {
      clearInterval(timer);
      void leaveDoc(id);
    };
  }, [focused, id, refreshPresence]);
  const value = resource.data;
  return (
    <>
      <Stack.Screen options={{ title: value?.title ?? t('work.title') }} />
      {value?.access !== 'viewer' && value && !value.archived_at ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button
            icon={toolbarIcon('pen')}
            accessibilityLabel={t('work.edit')}
            onPress={() => router.push({ pathname: '/knowledge/edit', params: { k: putHandoff('doc', value) } })}
          />
        </Stack.Toolbar>
      ) : null}
      {!value ? (
        <ResourceState error={resource.error} loading={resource.loading} retry={() => void resource.refresh()} />
      ) : (
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustKeyboardInsets
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 40 }}
        >
          {resource.error ? <ListRow title={t('work.loadFailed')} onPress={() => void resource.refresh()} /> : null}
          {others.data?.items
            .filter((p) => p.state === 'editing')
            .map((p) => (
              <Text key={p.member_id} style={s.presence}>
                {t('work.editing', { name: p.name })}
              </Text>
            ))}
          <View style={s.body}>
            <Markdown source={value.content} safe />
          </View>
          <ListSection>
            <ListRow
              title={t('work.versions')}
              icon="clock"
              accessory="chevron"
              onPress={() => router.push({ pathname: '/knowledge/versions', params: { id } })}
            />
            <ListRow
              title={t('work.sharing')}
              icon="users"
              accessory="chevron"
              onPress={() => router.push({ pathname: '/knowledge/shares', params: { id, kind: 'docs' } })}
            />
          </ListSection>
          <Comments id={id} />
        </ScrollView>
      )}
    </>
  );
}
const useStyles = makeStyles((c) => ({
  body: { paddingHorizontal: space.margin, paddingVertical: space.md },
  presence: { ...typo.footnote, color: c.secondaryLabel, padding: space.md },
}));
