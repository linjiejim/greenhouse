/** Native list adapter for official read surfaces without a dedicated phone screen. */
import React, { useCallback } from 'react';
import { ScrollView, Text } from 'react-native';
import { get } from '../api/client';
import { useResource } from '../data/use-resource';
import { Row } from '../ui/list';
import { Screen } from '../ui/screen';
import { EmptyState, LoadingState } from '../ui/empty';
import { useT } from '../lib/i18n';
import { useTheme, typo, space } from '../theme';
import type { NativeScreenEntry } from './native-types';
export function ResourceScreen({ entry, title }: { entry: NativeScreenEntry; title: string }) {
  const t = useT(),
    { colors: c } = useTheme();
  const resource = useResource(useCallback(() => get<Record<string, unknown>>(entry.endpoint!), [entry.endpoint]));
  const value = entry.collection ? resource.data?.[entry.collection] : resource.data;
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  return (
    <>
      <Screen title={title} />
      <ScrollView style={{ flex: 1, backgroundColor: c.groupedBackground }}>
        {resource.loading && !resource.data ? (
          <LoadingState />
        ) : resource.error ? (
          <EmptyState
            icon="alert"
            title={resource.error.message || t('places.pluginError')}
            onRetry={resource.error.status === 403 ? undefined : () => void resource.refresh()}
          />
        ) : !rows.length ? (
          <EmptyState icon={entry.icon} title={t('places.empty')} />
        ) : (
          rows.map((item, index) => {
            const row = item as Record<string, unknown>;
            return (
              <Row
                key={String(row.id ?? index)}
                title={String(row.title ?? row.name ?? row.content ?? row.description ?? title)}
                subtitle={String(row.summary ?? row.status ?? row.updated_at ?? '')}
                position="only"
              />
            );
          })
        )}
        <Text style={{ ...typo.caption1, color: c.secondaryLabel, padding: space.margin }}>{title}</Text>
      </ScrollView>
    </>
  );
}
