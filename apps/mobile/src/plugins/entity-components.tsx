import React, { useCallback, useState } from 'react';
import { FlatList, ScrollView, Text, TextInput, View, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { get, patch, del } from '../api/client';
import { useResource } from '../data/use-resource';
import { captureIdentity } from '../data/identity';
import { useEntityList } from './entity-hooks';
import { entityColumns, fieldText, writableValues, safeEndpoint, type EntityRow } from './surface-model';
import { localize, type PluginEntitySchema, type PluginEntityListPage } from '../shared/plugins';
import { usePrefs } from '../store/prefs';
import { usePeopleNames } from '../store/people';
import { peopleIds } from '../data/people';
import { useT } from '../lib/i18n';
import { Screen, SheetScreen } from '../ui/screen';
import { Row } from '../ui/list';
import { NativeButton } from '../ui/button';
import { EmptyState, LoadingState } from '../ui/empty';
import { NativeMenu } from '../ui/menu';
import { alertError, confirmAction } from '../ui/dialogs';
import { space, typo, useTheme } from '../theme';
import { useOpenObject } from '../shell/open-object';
export function EntityList({
  entity,
  page,
  plugin,
  detailPage,
}: {
  entity: PluginEntitySchema;
  page: PluginEntityListPage;
  plugin: string;
  detailPage: string;
}) {
  const t = useT(),
    lang = usePrefs((s) => s.lang),
    { colors: c } = useTheme(),
    open = useOpenObject();
  const [filters, setFilters] = useState<Record<string, string>>({}),
    [sort, setSort] = useState<{ field: string; dir: 'asc' | 'desc' }>();
  const view = entity.views.find((v) => v.id === (page.view ?? 'default')) ?? entity.views[0];
  const fields = entityColumns(entity, view);
  const list = useEntityList(entity, view, filters, sort);
  const names = usePeopleNames(peopleIds(entity.fields, list.items));
  return (
    <>
      <Screen title={localize(page.title, lang)} />
      <View style={{ padding: space.margin, gap: space.sm, backgroundColor: c.groupedBackground }}>
        {(view?.filters ?? []).map((key) => {
          const f = entity.fields.find((f) => f.key === key && f.filterable);
          return f ? (
            <TextInput
              key={key}
              accessibilityLabel={localize(f.title, lang)}
              placeholder={localize(f.title, lang)}
              value={filters[key] ?? ''}
              onChangeText={(value) => setFilters((v) => ({ ...v, [key]: value }))}
              style={{ ...typo.body, color: c.label, padding: space.sm }}
            />
          ) : null;
        })}
        <NativeMenu
          items={fields
            .filter((f) => f.sortable)
            .flatMap((f) =>
              (['asc', 'desc'] as const).map((dir) => ({
                id: `${f.key}:${dir}`,
                title: `${localize(f.title, lang)} ${dir === 'asc' ? '↑' : '↓'}`,
              })),
            )}
          onSelect={(id) => {
            const [field, dir] = id.split(':');
            setSort({ field, dir: dir as 'asc' | 'desc' });
          }}
        >
          <Text style={{ ...typo.body, color: c.accent }}>{t('places.sort')}</Text>
        </NativeMenu>
      </View>
      <FlatList
        data={list.items}
        keyExtractor={(r) => String(r.id)}
        onEndReached={list.more}
        onEndReachedThreshold={0.4}
        renderItem={({ item }) => (
          <Row
            title={String(item[entity.title_field] ?? item.id)}
            subtitle={fields
              .filter((f) => f.key !== entity.title_field)
              .map((f) => `${localize(f.title, lang)}: ${fieldText(f, item[f.key], lang, names)}`)
              .join(' · ')}
            onPress={() =>
              open({ kind: 'plugin-entity', plugin, page: detailPage, id: String(item.id), entity: entity.id })
            }
            position="only"
          />
        )}
        ListEmptyComponent={
          list.loading ? (
            <LoadingState />
          ) : (
            <EmptyState
              icon="form"
              title={list.error || t('places.empty')}
              onRetry={list.error ? () => void list.refresh() : undefined}
            />
          )
        }
        ListFooterComponent={list.loading && list.items.length ? <LoadingState /> : null}
      />
    </>
  );
}
export function EntityDetail({ entity, id }: { entity: PluginEntitySchema; id: string }) {
  const t = useT(),
    lang = usePrefs((s) => s.lang),
    router = useRouter(),
    { colors: c } = useTheme();
  const resource = useResource(
    useCallback(
      () =>
        safeEndpoint(entity.endpoint)
          ? get<EntityRow>(`${entity.endpoint}/${encodeURIComponent(id)}`)
          : Promise.resolve({
              ok: false as const,
              status: 400,
              code: 'invalid_endpoint',
              message: t('places.pluginError'),
            }),
      [entity.endpoint, id, t],
    ),
  );
  const [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [draft, setDraft] = useState<Record<string, string | boolean>>({});
  const row = resource.data;
  const names = usePeopleNames(peopleIds(entity.fields, row ? [row] : []));
  const edit = () => {
    setDraft(
      Object.fromEntries(
        entity.fields
          .filter((f) => f.writable === true)
          .map((f) => [
            f.key,
            f.kind === 'boolean'
              ? Boolean(row?.[f.key])
              : f.kind === 'json'
                ? JSON.stringify(row?.[f.key] ?? null)
                : String(row?.[f.key] ?? ''),
          ]),
      ),
    );
    setEditing(true);
  };
  const save = async () => {
    if (busy) return;
    let body: Record<string, unknown>;
    try {
      body = writableValues(entity, draft, row ?? undefined);
    } catch (error) {
      alertError(t('library.failed'), String(error));
      return;
    }
    const current = captureIdentity();
    setBusy(true);
    const r = await patch(`${entity.endpoint}/${encodeURIComponent(id)}`, body);
    if (!current()) return;
    setBusy(false);
    if (!r.ok) {
      alertError(t('library.failed'), r.message);
      return;
    }
    setEditing(false);
    void resource.refresh();
  };
  const remove = async () => {
    const current = captureIdentity();
    if (
      !(await confirmAction({
        title: t('places.deleteRecord'),
        destructive: true,
        confirmLabel: t('library.delete'),
      })) ||
      !current()
    )
      return;
    setBusy(true);
    const r = await del(`${entity.endpoint}/${encodeURIComponent(id)}`);
    if (!current()) return;
    setBusy(false);
    if (!r.ok) {
      alertError(t('library.failed'), r.message);
      return;
    }
    router.back();
  };
  return (
    <>
      <SheetScreen
        title={String(row?.[entity.title_field] ?? localize(entity.title, lang))}
        actions={
          row
            ? [
                ...(entity.actions.includes('update')
                  ? [{ icon: 'pen' as const, label: t('places.editRecord'), onPress: edit, disabled: busy }]
                  : []),
                ...(entity.actions.includes('delete')
                  ? [
                      {
                        icon: 'trash' as const,
                        label: t('places.deleteRecord'),
                        onPress: () => void remove(),
                        disabled: busy,
                      },
                    ]
                  : []),
              ]
            : []
        }
      />
      <ScrollView
        style={{ flex: 1, backgroundColor: c.background }}
        contentContainerStyle={{ padding: space.margin, gap: space.lg }}
      >
        {!row ? (
          resource.loading ? (
            <LoadingState />
          ) : (
            <EmptyState
              icon="alert"
              title={resource.error?.message || t('places.empty')}
              onRetry={resource.error?.status === 403 ? undefined : () => void resource.refresh()}
            />
          )
        ) : (
          entity.fields.map((field) => (
            <View key={field.key} style={{ gap: space.sm }}>
              <Text style={{ ...typo.footnote, color: c.secondaryLabel }}>{localize(field.title, lang)}</Text>
              {editing && field.writable === true ? (
                <View>
                  {field.kind === 'boolean' ? (
                    <Pressable
                      accessibilityRole="checkbox"
                      accessibilityLabel={localize(field.title, lang)}
                      accessibilityState={{ checked: !!draft[field.key] }}
                      onPress={() => setDraft((v) => ({ ...v, [field.key]: !v[field.key] }))}
                    >
                      <Text style={{ ...typo.body, color: c.label }}>{draft[field.key] ? '✓' : '○'}</Text>
                    </Pressable>
                  ) : field.kind === 'enum' ? (
                    <NativeMenu
                      items={(field.values ?? []).map((value) => ({
                        id: value,
                        title: value,
                        checked: draft[field.key] === value,
                      }))}
                      onSelect={(value) => setDraft((v) => ({ ...v, [field.key]: value }))}
                    >
                      <Text style={{ ...typo.body, color: c.label }}>{String(draft[field.key] || '—')} ▾</Text>
                    </NativeMenu>
                  ) : (
                    <TextInput
                      accessibilityLabel={localize(field.title, lang)}
                      value={String(draft[field.key] ?? '')}
                      multiline={field.kind === 'longText' || field.kind === 'json'}
                      keyboardType={['integer', 'number', 'money'].includes(field.kind) ? 'numeric' : 'default'}
                      onChangeText={(value) => setDraft((v) => ({ ...v, [field.key]: value }))}
                      style={{
                        ...typo.body,
                        color: c.label,
                        padding: space.sm,
                        borderWidth: 1,
                        borderColor: c.separator,
                        borderRadius: 8,
                      }}
                    />
                  )}
                </View>
              ) : (
                <Text selectable style={{ ...typo.body, color: c.label }}>
                  {fieldText(field, row[field.key], lang, names)}
                </Text>
              )}
            </View>
          ))
        )}
        {editing ? (
          <View style={{ gap: space.sm }}>
            <NativeButton label={t('common.save')} disabled={busy} onPress={() => void save()} />
            <NativeButton label={t('common.cancel')} disabled={busy} onPress={() => setEditing(false)} />
          </View>
        ) : null}
      </ScrollView>
    </>
  );
}
