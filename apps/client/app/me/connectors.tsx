/**
 * 连接 (「我」 → 连接): the outside services my agent can use through connectors. The ones that act
 * as me (my key or my sign-in) are listed with my standing; tap one for connect / test /
 * disconnect. The ones that need nothing from me are listed as ready. Adding connectors (the
 * team's, or my own) happens on the web (D13). Hidden behind an EmptyState when my account has
 * no connectors (403) or the station predates them (404).
 */

import React, { useCallback, useMemo } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { listMyConnectors, type MyConnector } from '../../src/api/connectors';
import { connectConnector, disconnect, testConnection } from '../../src/connectors/actions';
import { connectorSections, STATUS_LABEL } from '../../src/connectors/model';
import { noAccess } from '../../src/data/access';
import { useResource } from '../../src/data/use-resource';
import { useT } from '../../src/lib/i18n';
import { makeStyles, space, useTheme } from '../../src/theme';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { Badge, Row, Section, type BadgeTone } from '../../src/ui/list';
import { NativeMenu, menuSections } from '../../src/ui/menu';
import { usePullRefresh } from '../../src/ui/refresh';
import { Screen } from '../../src/ui/screen';

const TONE: Record<MyConnector['status'], BadgeTone> = {
  not_needed: 'neutral',
  not_connected: 'neutral',
  connected: 'green',
  needs_reauth: 'orange',
  error: 'red',
};

export default function MyConnectorsPage() {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const list = useResource(useCallback(() => listMyConnectors(), []));
  const pull = usePullRefresh(list.refresh);
  const sections = useMemo(() => (list.data ? connectorSections(list.data) : null), [list.data]);

  const act = async (id: string, connector: MyConnector) => {
    const target = { id: connector.id, name: connector.name, auth_kind: connector.auth_kind };
    const changed =
      id === 'connect'
        ? await connectConnector(target)
        : id === 'test'
          ? await testConnection(target)
          : await disconnect(target);
    if (changed) void list.refresh();
  };

  if (!list.data) {
    return (
      <View style={styles.root}>
        <Screen title={t('connectors.title')} />
        {list.loading ? (
          <LoadingState />
        ) : (
          <ScrollView contentInsetAdjustmentBehavior="automatic">
            <EmptyState
              icon="link"
              title={noAccess(list.error) ? t('connectors.unavailable') : t('connectors.loadFailed')}
              message={noAccess(list.error) ? t('connectors.unavailableHint') : list.error?.message || undefined}
              onRetry={noAccess(list.error) ? undefined : () => void list.refresh()}
              style={styles.state}
            />
          </ScrollView>
        )}
      </View>
    );
  }

  const { mine, ready } = sections!;
  return (
    <>
      <Screen title={t('connectors.title')} busy={list.loading && !pull.refreshing} />
      <ScrollView
        style={styles.root}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      >
        {mine.length === 0 && ready.length === 0 ? (
          <EmptyState icon="link" title={t('connectors.empty')} message={t('connectors.emptyHint')} style={styles.state} />
        ) : null}
        {mine.length ? (
          <Section header={t('connectors.needsYou')} footer={t('connectors.needsYouFooter')}>
            {mine.map((connector) => {
              const connected = connector.status === 'connected' || connector.status === 'error';
              const connectLabel =
                connector.auth_kind === 'oauth'
                  ? connector.status === 'not_connected'
                    ? t('connectors.connect')
                    : t('connectors.reconnect')
                  : connector.status === 'not_connected'
                    ? t('connectors.addKey')
                    : t('connectors.replaceKey');
              return (
                <NativeMenu
                  key={connector.id}
                  title={connector.name}
                  items={menuSections([
                    [
                      { id: 'connect', title: connectLabel, icon: connector.auth_kind === 'oauth' ? 'link' : 'key' },
                      ...(connected ? [{ id: 'test', title: t('connectors.test'), icon: 'checkCircle' as const }] : []),
                    ],
                    connected ? [{ id: 'disconnect', title: t('connectors.disconnect'), destructive: true }] : [],
                  ])}
                  onSelect={(id) => void act(id, connector)}
                  fill
                >
                  <Row
                    title={connector.name}
                    subtitle={connector.error || connector.last_error || connector.description || connector.handle}
                    icon={connector.auth_kind === 'oauth' ? 'link' : 'key'}
                    accessory={<Badge label={t(STATUS_LABEL[connector.status])} tone={TONE[connector.status]} />}
                    menuTrigger
                  />
                </NativeMenu>
              );
            })}
          </Section>
        ) : null}
        {ready.length ? (
          <Section header={t('connectors.ready')} footer={t('connectors.readyFooter')}>
            {ready.map((connector) => (
              <Row
                key={connector.id}
                title={connector.name}
                subtitle={connector.description || connector.handle}
                icon="checkCircle"
              />
            ))}
          </Section>
        ) : null}
      </ScrollView>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingBottom: space.xxxl * 2 },
  state: { paddingTop: space.xxxl },
}));
