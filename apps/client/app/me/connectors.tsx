/**
 * 连接 (「我」 → 连接): the outside services my agent can use through connectors. The team's that
 * act as me (my key or my sign-in) are listed with my standing; tap one for connect / test /
 * disconnect. The team's that need nothing from me are listed as ready. My own (personal,
 * `me/<slug>`) connectors follow with connect / test / refresh / delete; the browser also adds and
 * edits them (src/connectors/personal-form.web.tsx), the phone says to use a wider window. Team
 * connectors are a super's (Admin › Team connectors). Hidden behind an EmptyState when my account
 * has no connectors (403). In the browser, linked accounts (Feishu, WeCom) come first
 * (src/connectors/provider-bindings.web.tsx).
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Platform, RefreshControl, ScrollView, View } from 'react-native';
import { listMyConnectors, type MyConnector, type PersonalConnector } from '../../src/api/connectors';
import {
  connectConnector,
  deleteOwnConnector,
  disconnect,
  refreshOwnConnector,
  testConnection,
} from '../../src/connectors/actions';
import { PersonalConnectorDialog } from '../../src/connectors/personal-form';
import { connectorSections, STATUS_LABEL } from '../../src/connectors/model';
import { ProviderBindings } from '../../src/connectors/provider-bindings';
import { noAccess } from '../../src/data/access';
import { useResource } from '../../src/data/use-resource';
import { useT } from '../../src/lib/i18n';
import { makeStyles, space, useTheme } from '../../src/theme';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { Badge, Row, Section, SectionFooter, SectionHeader, type BadgeTone } from '../../src/ui/list';
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
  // Only the browser adds and edits my own connectors (a form too large for a phone sheet).
  const canEdit = Platform.OS === 'web';
  const [editing, setEditing] = useState<{ existing?: PersonalConnector } | null>(null);

  const act = async (id: string, connector: MyConnector) => {
    if (id === 'edit') {
      setEditing({ existing: list.data?.personal.find((own) => own.id === connector.id) });
      return;
    }
    const target = { id: connector.id, name: connector.name, auth_kind: connector.auth_kind };
    const changed =
      id === 'connect'
        ? await connectConnector(target)
        : id === 'test'
          ? await testConnection(target)
          : id === 'refresh'
            ? await refreshOwnConnector(target)
            : id === 'delete'
              ? await deleteOwnConnector(target)
              : await disconnect(target);
    if (changed) void list.refresh();
  };
  const connectItem = (connector: MyConnector) => ({
    id: 'connect',
    title:
      connector.auth_kind === 'oauth'
        ? connector.status === 'not_connected'
          ? t('connectors.connect')
          : t('connectors.reconnect')
        : connector.status === 'not_connected'
          ? t('connectors.addKey')
          : t('connectors.replaceKey'),
    icon: connector.auth_kind === 'oauth' ? ('link' as const) : ('key' as const),
  });
  const dialog = editing ? (
    <PersonalConnectorDialog
      existing={editing.existing}
      close={() => setEditing(null)}
      saved={() => void list.refresh()}
    />
  ) : null;

  if (!list.data) {
    return (
      <View style={styles.root}>
        <Screen title={t('connectors.title')} />
        {list.loading ? (
          <LoadingState />
        ) : (
          <ScrollView contentInsetAdjustmentBehavior="automatic">
            <ProviderBindings />
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

  const { mine, ready, own } = sections!;
  return (
    <>
      <Screen
        title={t('connectors.title')}
        busy={list.loading && !pull.refreshing}
        actions={canEdit ? [{ icon: 'plus', label: t('connectors.addOwn'), onPress: () => setEditing({}) }] : []}
      />
      {dialog}
      <ScrollView
        style={styles.root}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      >
        <ProviderBindings />
        {mine.length === 0 && ready.length === 0 && own.length === 0 ? (
          <EmptyState
            icon="link"
            title={t('connectors.empty')}
            message={t('connectors.emptyHint')}
            style={styles.state}
          />
        ) : null}
        {mine.length ? (
          <Section header={t('connectors.needsYou')} footer={t('connectors.needsYouFooter')}>
            {mine.map((connector) => {
              const connected = connector.status === 'connected' || connector.status === 'error';
              return (
                <NativeMenu
                  key={connector.id}
                  title={connector.name}
                  items={menuSections([
                    [
                      connectItem(connector),
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
        {own.length || canEdit ? (
          <Section
            header={t('connectors.own')}
            footer={canEdit ? t('connectors.ownFooter') : t('connectors.ownFooterPhone')}
          >
            {[
              ...own.map((connector) => {
                const connected = connector.status === 'connected' || connector.status === 'error';
                const perMember = connector.auth_mode === 'per_member';
                return (
                  <NativeMenu
                    key={connector.id}
                    title={connector.name}
                    items={menuSections([
                      [
                        ...(perMember ? [connectItem(connector)] : []),
                        ...(connected || !perMember
                          ? [{ id: 'test', title: t('connectors.test'), icon: 'checkCircle' as const }]
                          : []),
                        { id: 'refresh', title: t('connectors.refresh'), icon: 'refresh' as const },
                        ...(canEdit ? [{ id: 'edit', title: t('connectors.edit'), icon: 'pen' as const }] : []),
                      ],
                      [
                        ...(perMember && connected ? [{ id: 'disconnect', title: t('connectors.disconnect') }] : []),
                        { id: 'delete', title: t('connectors.delete'), icon: 'trash' as const, destructive: true },
                      ],
                    ])}
                    onSelect={(id) => void act(id, connector)}
                    fill
                    testID={`own-connector-${connector.slug}`}
                  >
                    <Row
                      title={connector.name}
                      subtitle={connector.last_error || connector.description || connector.handle}
                      icon={perMember ? (connector.auth_kind === 'oauth' ? 'link' : 'key') : 'checkCircle'}
                      accessory={<Badge label={t(STATUS_LABEL[connector.status])} tone={TONE[connector.status]} />}
                      menuTrigger
                    />
                  </NativeMenu>
                );
              }),
              ...(canEdit
                ? [
                    <Row
                      key="add"
                      title={t('connectors.addOwn')}
                      icon="plus"
                      accessory="none"
                      onPress={() => setEditing({})}
                    />,
                  ]
                : []),
            ]}
          </Section>
        ) : mine.length || ready.length ? (
          // the phone cannot add one, so say where that happens instead of leaving the place out
          <View>
            <SectionHeader title={t('connectors.own')} />
            <SectionFooter text={t('connectors.ownNonePhone')} />
          </View>
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
