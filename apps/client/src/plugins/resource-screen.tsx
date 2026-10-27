/** Native list adapter for official read surfaces without a dedicated phone screen. */
import React, { useCallback } from 'react';
import { ScrollView } from 'react-native';
import { get } from '../api/client';
import { useResource } from '../data/use-resource';
import { Row, rowPosition } from '../ui/list';
import { Screen } from '../ui/screen';
import { EmptyState, LoadingState } from '../ui/empty';
import { useT } from '../lib/i18n';
import { relativeTimeNow } from '../lib/time-words';
import { useTheme, space } from '../theme';
import type { NativeScreenEntry } from './native-types';
import { resourceOf } from './resource-model';
export function ResourceScreen({ entry, title }: { entry: NativeScreenEntry; title: string }) {
  const t = useT(),
    { colors: c } = useTheme();
  const resource = useResource(useCallback(() => get<Record<string, unknown>>(entry.endpoint!), [entry.endpoint]));
  const data = resource.data ? resourceOf(resource.data, entry.collection) : null;
  const items =
    data?.kind === 'facts'
      ? data.facts.map((f) => ({
          id: f.key,
          title: f.label,
          subtitle:
            f.value === null ? '—' : typeof f.value === 'boolean' ? t(f.value ? 'common.yes' : 'common.no') : String(f.value),
        }))
      : (data?.rows ?? []).map((r) => ({
          id: r.id,
          title: r.title,
          subtitle: [r.subtitle, r.status, r.time ? relativeTimeNow(r.time) : undefined].filter(Boolean).join(' · '),
        }));
  return (
    <>
      <Screen title={title} />
      <ScrollView
        style={{ flex: 1, backgroundColor: c.groupedBackground }}
        contentContainerStyle={{ paddingVertical: space.md }}
      >
        {resource.loading && !resource.data ? (
          <LoadingState />
        ) : resource.error ? (
          <EmptyState
            icon="alert"
            title={resource.error.message || t('places.pluginError')}
            onRetry={resource.error.status === 403 ? undefined : () => void resource.refresh()}
          />
        ) : !items.length ? (
          <EmptyState icon={entry.icon} title={t('client.noItems')} message={title} />
        ) : (
          items.map((item, index) => (
            <Row
              key={item.id}
              title={item.title}
              subtitle={item.subtitle || undefined}
              position={rowPosition(index, items.length)}
            />
          ))
        )}
      </ScrollView>
    </>
  );
}
