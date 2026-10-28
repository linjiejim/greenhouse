/**
 * My model-gateway keys (「我」 → 我的 Agent): each key with its prefix, last use and this month's
 * spend; New Key asks for a name and shows the secret once, in a card with Copy, until dismissed
 * (it is never shown again); an active key's menu revokes it after a confirmation. Creating needs
 * the station's gateway switch; revoking never does. Every write is bound to the identity that
 * started it (captureIdentity), so a late answer after a station or member switch is dropped.
 */

import React, { useState } from 'react';
import { Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { createGatewayKey, revokeGatewayKey } from '../api/agent';
import { captureIdentity } from '../data/identity';
import { formatUsd } from '../data/money';
import { useT } from '../lib/i18n';
import { relativeTimeNow } from '../lib/time-words';
import type { GatewayKey, GatewayOverview } from '../shared/greenhouse-types';
import { makeStyles, mono, space, typo, useTheme, weight } from '../theme';
import { NativeButton } from '../ui/button';
import { alertError, confirmAction, promptText } from '../ui/dialogs';
import { Badge, Card, Row, Section, SectionFooter } from '../ui/list';
import { NativeMenu } from '../ui/menu';
import { toast } from '../ui/toast';

export function GatewayKeys({ gateway, onChanged }: { gateway: GatewayOverview; onChanged: () => void }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    const name = await promptText({
      title: t('gatewayKeys.createTitle'),
      message: t('gatewayKeys.createHint'),
      placeholder: t('gatewayKeys.namePlaceholder'),
      confirmLabel: t('gatewayKeys.create'),
    });
    if (!name) return;
    const same = captureIdentity();
    setBusy(true);
    const answer = await createGatewayKey(name.slice(0, 80));
    setBusy(false);
    if (!same()) return;
    if (!answer.ok) {
      alertError(t('gatewayKeys.createFailed'), answer.message || undefined);
      return;
    }
    setSecret({ name: answer.data.key.name, value: answer.data.secret });
    onChanged();
  };

  const revoke = async (key: GatewayKey) => {
    const sure = await confirmAction({
      title: t('gatewayKeys.revokeTitle', { name: key.name }),
      message: t('gatewayKeys.revokeHint'),
      confirmLabel: t('gatewayKeys.revoke'),
      destructive: true,
    });
    if (!sure) return;
    const same = captureIdentity();
    const answer = await revokeGatewayKey(key.id);
    if (!same()) return;
    if (!answer.ok) {
      alertError(t('gatewayKeys.revokeFailed'), answer.message || undefined);
      return;
    }
    toast(t('gatewayKeys.revoked', { name: key.name }), 'checkCircle');
    onChanged();
  };

  const copy = async () => {
    if (!secret) return;
    await Clipboard.setStringAsync(secret.value).catch(() => {});
    toast(t('common.copied'), 'copy');
  };

  return (
    <>
      {secret ? (
        <Card style={styles.secret}>
          <View testID="gateway-secret">
            <Text style={styles.secretTitle}>{t('gatewayKeys.secretTitle', { name: secret.name })}</Text>
            <Text selectable style={styles.secretValue}>
              {secret.value}
            </Text>
            <Text style={styles.secretHint}>{t('gatewayKeys.secretHint')}</Text>
            <View style={styles.secretActions}>
              <NativeButton label={t('gatewayKeys.copy')} icon="copy" variant="prominent" onPress={() => void copy()} />
              <NativeButton label={t('gatewayKeys.secretDone')} onPress={() => setSecret(null)} />
            </View>
          </View>
        </Card>
      ) : null}
      <Section header={t('agent.keys')}>
        {[
          ...gateway.keys.map((key) => {
            const row = (
              <Row
                key={key.id}
                title={key.name}
                subtitle={[
                  `${key.prefix}…`,
                  key.last_used_at
                    ? t('agent.lastUsed', { when: relativeTimeNow(key.last_used_at) })
                    : t('agent.neverUsed'),
                  t('agent.keyMonth', { amount: formatUsd(key.month_spend_usd_micros), n: key.month_calls }),
                ].join('\n')}
                subtitleLines={3}
                icon="key"
                menuTrigger={key.status === 'active'}
                accessory={
                  <Badge
                    label={t(`agent.keyStatus.${key.status}`)}
                    tone={key.status === 'active' ? 'green' : 'neutral'}
                  />
                }
              />
            );
            return key.status === 'active' ? (
              <NativeMenu
                key={key.id}
                title={key.name}
                items={[{ id: 'revoke', title: t('gatewayKeys.revoke'), icon: 'trash', destructive: true }]}
                onSelect={() => void revoke(key)}
                fill
                testID={`gateway-key-${key.id}`}
              >
                {row}
              </NativeMenu>
            ) : (
              row
            );
          }),
          ...(gateway.keys.length
            ? []
            : [<Row key="empty" title={t('agent.keysEmpty')} icon="key" accessory="none" />]),
          ...(gateway.enabled
            ? [
                <Row
                  key="new"
                  title={busy ? t('common.loading') : t('gatewayKeys.new')}
                  icon="plus"
                  accessory="none"
                  disabled={busy}
                  onPress={() => void create()}
                />,
              ]
            : []),
        ]}
      </Section>
      <SectionFooter text={gateway.enabled ? t('gatewayKeys.hint') : t('agent.gatewayOff')} />
    </>
  );
}

const useStyles = makeStyles((c) => ({
  secret: { marginTop: space.md, padding: space.lg },
  secretTitle: { ...typo.headline, fontWeight: weight.semibold, color: c.label },
  secretValue: { ...typo.callout, fontFamily: mono, color: c.label, marginTop: space.sm },
  secretHint: { ...typo.footnote, color: c.secondaryLabel, marginTop: space.sm },
  secretActions: { flexDirection: 'row', gap: space.sm, marginTop: space.md, flexWrap: 'wrap' },
}));
