/**
 * Settings → 连接器 (`/settings/connectors`, a large-title page in the settings
 * stack) — the connectors an admin installed and where the member stands on
 * each (web parity: Settings → Connectors; spec 20261009-mcp-connectors).
 * Installing one stays on the web (Administration → MCP Servers).
 *
 * A row: the name, what it does, whose credential it runs on and how many
 * tools; its state on the right. Tapping it offers what fits that state —
 * 连接 (sign in, in an in-app browser) or 添加 key, 去哪里获取, 测试, 更换 key /
 * 重新连接, 断开 (confirmed). The list is read again after each, and whenever
 * the app comes back to the front (src/connectors/use-connectors.ts).
 */

import React, { useMemo, useState } from 'react';
import { ScrollView } from 'react-native';
import { Stack } from 'expo-router';
import type { Connector } from '../../src/api/connectors';
import { CONNECTOR_AUTH_LABEL, CONNECTOR_STATUS_LABEL } from '../../src/connectors/labels';
import { connect, disconnect, test, useConnectors } from '../../src/connectors/use-connectors';
import { openLink } from '../../src/lib/links';
import { useT, type TFunction } from '../../src/lib/i18n';
import { space, useTheme } from '../../src/theme';
import { Spinner } from '../../src/ui/core';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { ListRow, ListSection } from '../../src/ui/list';
import { NativeMenu, menuSections, type MenuItem } from '../../src/ui/menu';

/** Empty / failed states sit in the middle of the page. */
const CENTERED = { flexGrow: 1, justifyContent: 'center' } as const;

export default function SettingsConnectors() {
  const t = useT();
  const { load, reload } = useConnectors();
  const list = typeof load === 'object' && load.enabled ? load.connectors : null;

  return (
    <>
      <Stack.Screen options={{ title: t('connectors.title') }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[{ paddingTop: space.sm, paddingBottom: space.xxxl }, !list?.length && CENTERED]}
      >
        {load === 'loading' ? (
          <LoadingState />
        ) : load === 'error' ? (
          <EmptyState icon="alert" title={t('connectors.loadFailed')} onRetry={() => void reload()} />
        ) : !load.enabled ? (
          <EmptyState icon="plug" title={t('connectors.disabledTitle')} message={t('connectors.disabledDesc')} />
        ) : !load.connectors.length ? (
          <EmptyState icon="plug" title={t('connectors.noneTitle')} message={t('connectors.noneDesc')} />
        ) : (
          <ListSection footer={t('connectors.intro')}>
            {load.connectors.map((connector, index) => (
              <ConnectorRow
                key={connector.id}
                connector={connector}
                last={index === load.connectors.length - 1}
                onChanged={reload}
              />
            ))}
          </ListSection>
        )}
      </ScrollView>
    </>
  );
}

function ConnectorRow({
  connector,
  last,
  onChanged,
}: {
  connector: Connector;
  last: boolean;
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const { colors: c, hex } = useTheme();
  const items = useMemo(() => menuFor(connector, t), [connector, t]);
  const status = t(CONNECTOR_STATUS_LABEL[connector.status]);
  const facts = [
    t(CONNECTOR_AUTH_LABEL[connector.auth_mode]),
    connector.tool_count ? t('connectors.toolsN', { n: connector.tool_count }) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  // a key is tried against the provider before it is kept — that can take a while
  const [busy, setBusy] = useState(false);
  const onSelect = async (id: string) => {
    if (id === 'getKey') {
      if (connector.credential_url) await openLink(connector.credential_url, hex.accent);
      return;
    }
    setBusy(true);
    if (id === 'connect') await connect(connector);
    else if (id === 'test') await test(connector);
    else if (id === 'disconnect') await disconnect(connector);
    await onChanged();
    setBusy(false);
  };

  return (
    <NativeMenu trigger="tap" fill items={items} onSelect={(id) => void onSelect(id)}>
      <ListRow
        icon="plug"
        iconTint={connector.status === 'expired' ? c.orange : connector.status === 'not_connected' ? c.gray : c.accent}
        title={connector.name}
        // whose credential and how many tools first (always visible), then what it does
        subtitle={[facts, connector.description].filter(Boolean).join('\n')}
        subtitleLines={3}
        value={busy ? undefined : status}
        accessory={busy ? <Spinner /> : 'none'}
        menuTrigger
        last={last}
      />
    </NativeMenu>
  );
}

/** What a row offers, by its state. */
function menuFor(connector: Connector, t: TFunction): MenuItem[] {
  const key = connector.auth_mode === 'per_user';
  const personal = key || connector.auth_mode === 'oauth';
  const connectItem: MenuItem = {
    id: 'connect',
    icon: key ? 'key' : 'plug',
    title:
      connector.status === 'connected'
        ? key
          ? t('connectors.replaceKey')
          : t('connectors.reconnect')
        : connector.status === 'expired'
          ? t('connectors.reconnect')
          : key
            ? t('connectors.addKey')
            : t('connectors.connect'),
  };
  const getKey: MenuItem[] =
    key && connector.credential_url ? [{ id: 'getKey', icon: 'globe', title: t('connectors.getKey') }] : [];
  const testItem: MenuItem = { id: 'test', icon: 'refresh', title: t('connectors.test') };
  const disconnectItem: MenuItem = {
    id: 'disconnect',
    icon: 'trash',
    title: t('connectors.disconnect'),
    destructive: true,
  };
  if (!personal) return [testItem];
  if (connector.status === 'connected') return menuSections([[testItem, connectItem], [disconnectItem]]);
  if (connector.status === 'expired') return menuSections([[connectItem], [disconnectItem]]);
  return menuSections([[connectItem, ...getKey]]);
}
