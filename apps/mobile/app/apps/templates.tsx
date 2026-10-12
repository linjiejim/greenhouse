/** Native template catalog; installation creates a Base and app through the server plan. */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, RefreshControl, Text } from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { installTemplate, listTemplates } from '../../src/api/apps';
import { appAccent, appIcon } from '../../src/apps/meta';
import { useApps } from '../../src/apps/store';
import { templateInstallable } from '../../src/apps/templates';
import { useT } from '../../src/lib/i18n';
import type { AppTemplateSummary } from '../../src/shared/apps';
import { TablesRouteGate } from '../../src/tables/route-gate';
import { makeStyles, space, typo, useTheme } from '../../src/theme';
import { alertError, promptText } from '../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { useFontScaleKey } from '../../src/ui/font-scale';
import { ListRow, type RowPosition } from '../../src/ui/list';

export default function AppTemplatesScreen() {
  return (
    <TablesRouteGate area="apps">
      <TablesRouteGate area="tables">
        <TemplateCatalog />
      </TablesRouteGate>
    </TablesRouteGate>
  );
}

function position(index: number, count: number): RowPosition {
  return count === 1 ? 'only' : index === 0 ? 'first' : index === count - 1 ? 'last' : 'middle';
}

function TemplateCatalog() {
  const t = useT();
  const router = useRouter();
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const fontKey = useFontScaleKey();
  const [templates, setTemplates] = useState<AppTemplateSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const alive = useRef(true);
  const installing = useRef(false);
  const sequence = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const reload = useCallback(async () => {
    const current = ++sequence.current;
    const answer = await listTemplates();
    if (!alive.current || current !== sequence.current) return;
    setFailed(!answer.ok);
    if (answer.ok) setTemplates(answer.value);
  }, []);
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  const install = async (template: AppTemplateSummary) => {
    if (installing.current || !templateInstallable(template)) return;
    installing.current = true;
    try {
      const name = await promptText({
        title: t('apps.templates.install'),
        message: t('apps.templates.installHint'),
        defaultValue: template.name,
        confirmLabel: t('apps.templates.install'),
      });
      if (!name || !alive.current) return;
      if (name.length > 60) {
        alertError(t('apps.templates.nameInvalid'));
        return;
      }
      setBusy(template.key);
      const result = await installTemplate(template.key, name);
      if (!alive.current) return;
      if (!result.ok) {
        alertError(t('apps.templates.installFailed'), result.message);
        return;
      }
      await useApps.getState().loadCatalog();
      if (!alive.current) return;
      router.replace({
        pathname: '/apps/[appId]',
        params: { appId: String(result.value.app.id), name: result.value.app.name },
      });
    } finally {
      installing.current = false;
      if (alive.current) setBusy(null);
    }
  };

  return (
    <>
      <Stack.Screen options={{ title: t('apps.templates.title') }} />
      <FlatList
        data={templates ?? []}
        keyExtractor={(template) => template.key}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ flexGrow: 1, paddingVertical: space.sm }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={hex.accent}
            onRefresh={async () => {
              setRefreshing(true);
              await reload();
              if (alive.current) setRefreshing(false);
            }}
          />
        }
        ListHeaderComponent={
          <Text key={fontKey} style={styles.hint}>
            {t('apps.templates.intro')}
          </Text>
        }
        renderItem={({ item, index }) => {
          const ready = templateInstallable(item);
          return (
            <ListRow
              title={item.name}
              subtitle={item.description}
              subtitleLines={2}
              icon={appIcon(item.icon)}
              iconTint={appAccent(item.accent, c)}
              disabled={!ready || busy !== null}
              accessory={ready ? 'chevron' : undefined}
              position={position(index, templates?.length ?? 0)}
              onPress={ready ? () => void install(item) : undefined}
              footer={
                busy === item.key || !ready ? (
                  <Text key={fontKey} style={styles.detail}>
                    {busy === item.key ? t('apps.templates.installing') : t('apps.templates.reviewRequired')}
                  </Text>
                ) : undefined
              }
            />
          );
        }}
        ListEmptyComponent={
          templates === null && !failed ? (
            <LoadingState />
          ) : failed ? (
            <EmptyState icon="alert" title={t('apps.templates.loadFailed')} onRetry={() => void reload()} />
          ) : (
            <EmptyState icon="apps" title={t('apps.templates.empty')} />
          )
        }
      />
    </>
  );
}

const useStyles = makeStyles((c) => ({
  hint: {
    ...typo.footnote,
    color: c.secondaryLabel,
    marginHorizontal: space.margin + space.md,
    marginVertical: space.md,
  },
  detail: { ...typo.caption1, color: c.secondaryLabel },
}));
