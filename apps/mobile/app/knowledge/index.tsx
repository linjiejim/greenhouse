import { visiblePages } from '../../src/data/pages';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { roots, folder, searchKnowledge } from '../../src/api/knowledge';
import { post, type ApiResult } from '../../src/api/client';
import { useResource } from '../../src/data/use-resource';
import { ResourceState } from '../../src/knowledge/state';
import { useT } from '../../src/lib/i18n';
import type { KnowledgeItem, KnowledgeScope, KnowledgeDoc, KnowledgeFolder } from '../../src/shared/contract';
import { useAuth } from '../../src/store/auth';
import { ListRow, ListSection } from '../../src/ui/list';
import { NativeMenu } from '../../src/ui/menu';
import { NativeButton } from '../../src/ui/button';
import { EmptyState } from '../../src/ui/empty';
import { alertError, promptText } from '../../src/ui/dialogs';
import { toolbarIcon } from '../../src/ui/toolbar-icon';

type Item = Pick<KnowledgeItem, 'id' | 'name' | 'type'> & { snippet?: string };
type Directory = { name: string; items: Item[]; next_cursor: string | null };

export default function Knowledge() {
  const { folder: folderId, scope = 'personal' } = useLocalSearchParams<{ folder?: string; scope?: KnowledgeScope }>();
  const t = useT();
  const router = useRouter();
  const allowed = useAuth((s) => s.user?.modules.knowledge);
  const [search, setSearch] = useState('');
  const visible = useRef(1);
  useEffect(() => {
    visible.current = 1;
    setPaging(false);
  }, [folderId, scope, search]);
  const load = useCallback(async (): Promise<ApiResult<Directory>> => {
    if (search.trim()) {
      const result = await searchKnowledge(search.trim().slice(0, 200), scope, folderId);
      return result.ok
        ? {
            ok: true as const,
            data: {
              name: t('work.title'),
              items: result.data.items.map((hit) => ({
                ...hit,
                name: hit.title,
                access: 'viewer',
                snippet: hit.snippet,
              })),
              next_cursor: null,
            },
          }
        : result;
    }
    if (folderId) {
      const result = await visiblePages(async (cursor) => {
        const page = await folder(folderId, cursor);
        return page.ok ? { ok: true as const, data: { ...page.data, items: page.data.children } } : page;
      }, visible.current);
      return result.ok
        ? {
            ok: true as const,
            data: { name: result.data.name, items: result.data.items, next_cursor: result.data.next_cursor },
          }
        : result;
    }
    const result = await visiblePages((cursor) => roots(scope, cursor), visible.current);
    return result.ok ? { ok: true as const, data: { name: t('work.title'), ...result.data } } : result;
  }, [search, scope, folderId, t]);
  const resource = useResource(load, ['knowledge.changed', 'doc.updated', 'comments.updated']);
  const [paging, setPaging] = useState(false);
  const more = async () => {
    const current = resource.capture();
    if (!resource.data?.next_cursor || paging) return;
    setPaging(true);
    const cursor = resource.data.next_cursor;
    const result = folderId ? await folder(folderId, cursor) : await roots(scope, cursor);
    setPaging(false);
    if (!current()) return;
    if (!result.ok) {
      alertError(t('work.loadFailed'), undefined, result.message);
      return;
    }
    visible.current++;
    const rows = 'children' in result.data ? result.data.children : result.data.items;
    resource.setData((previous) =>
      previous
        ? {
            ...previous,
            items: [...previous.items, ...rows.filter((row) => !previous.items.some((old) => old.id === row.id))],
            next_cursor: result.data.next_cursor,
          }
        : previous,
    );
  };
  const open = (item: Pick<KnowledgeItem, 'id' | 'name' | 'type'>) => {
    if (item.type === 'folder') router.push({ pathname: '/knowledge', params: { folder: item.id, scope } });
    else router.push({ pathname: item.type === 'doc' ? '/knowledge/doc' : '/knowledge/file', params: { id: item.id } });
  };
  const create = async (kind: 'doc' | 'folder') => {
    const current = resource.captureWrite();
    const name = await promptText({
      title: t(kind === 'doc' ? 'work.newDoc' : 'work.newFolder'),
      placeholder: t('work.name'),
    });
    if (!name?.trim() || !current()) return;
    const result = await post<KnowledgeDoc | KnowledgeFolder>(`/api/knowledge/${kind === 'doc' ? 'docs' : 'folders'}`, {
      [kind === 'doc' ? 'title' : 'name']: name.trim(),
      ...(folderId ? { folder_id: folderId } : { space: scope }),
    });
    if (!current()) return;
    if (!result.ok) {
      alertError(t('work.createFailed'), undefined, result.message);
      return;
    }
    open({ ...result.data, type: kind, name });
  };
  return (
    <>
      <Stack.Screen options={{ title: resource.data?.name ?? t('work.title') }} />
      <Stack.SearchBar placeholder={t('work.search')} onChangeText={(event) => setSearch(event.nativeEvent.text)} />
      {allowed && scope !== 'shared' ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Menu icon={toolbarIcon('plus')} accessibilityLabel={t('work.newDoc')}>
            <Stack.Toolbar.MenuAction onPress={() => void create('doc')}>{t('work.newDoc')}</Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction onPress={() => void create('folder')}>
              {t('work.newFolder')}
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
        </Stack.Toolbar>
      ) : null}
      {!allowed ? (
        <EmptyState icon="book" title={t('work.permissionLost')} />
      ) : !resource.data ? (
        <ResourceState loading={resource.loading} retry={() => void resource.refresh()} />
      ) : (
        <FlatList
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingBottom: 40 }}
          data={resource.data.items}
          keyExtractor={(item) => item.id}
          refreshing={resource.loading}
          onRefresh={() => void resource.refresh()}
          ListHeaderComponent={
            !folderId ? (
              <ListSection>
                <NativeMenu
                  items={(['team', 'personal', 'shared'] as const).map((id) => ({
                    id,
                    title: t(`work.${id}`),
                    checked: id === scope,
                  }))}
                  onSelect={(id) => router.setParams({ scope: id })}
                >
                  <ListRow title={t(`work.${scope}`)} menuTrigger accessory="chevron" />
                </NativeMenu>
              </ListSection>
            ) : null
          }
          renderItem={({ item, index }) => (
            <ListRow
              position={
                index === 0
                  ? resource.data!.items.length === 1
                    ? 'only'
                    : 'first'
                  : index === resource.data!.items.length - 1
                    ? 'last'
                    : 'middle'
              }
              title={item.name}
              subtitle={'snippet' in item ? String(item.snippet) : undefined}
              icon={item.type === 'folder' ? 'folder' : item.type === 'doc' ? 'file' : 'attach'}
              onPress={() => open(item)}
              accessory="chevron"
            />
          )}
          ListEmptyComponent={<EmptyState icon="book" title={t('work.empty')} />}
          ListFooterComponent={
            resource.data.next_cursor ? (
              <NativeButton label={t('work.more')} loading={paging} onPress={() => void more()} />
            ) : null
          }
        />
      )}
    </>
  );
}
