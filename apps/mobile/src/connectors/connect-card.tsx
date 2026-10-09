/**
 * The "Connect X" card — what `mcp_call` answers when a connector runs on the
 * member's own account and they haven't connected it (web parity:
 * McpConnectCard; spec 20261009-mcp-connectors D7). It sits under the reply
 * that explains why (src/chat/artifacts.tsx). 连接 / 重新连接 opens the
 * provider's sign-in, 添加 key asks for the key (./use-connectors.ts); once
 * connected, 继续 asks the agent to try again — as the member's next message,
 * only while nothing has followed the reply yet.
 *
 * The card reads the member's state on mount (and whenever the app comes
 * back to the front), so an old card in a conversation's history shows
 * "Connected" instead of asking again. A read-only conversation shows it
 * without buttons.
 */

import React, { useState } from 'react';
import { Text, View } from 'react-native';
import type { NeedsConnection } from '../api/connectors';
import { ChatCard } from '../chat/chat-card';
import { useT } from '../lib/i18n';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { NativeButton } from '../ui/button';
import { Icon } from '../ui/core';
import { connect, useConnectors } from './use-connectors';

export function ConnectCard({
  data,
  followUp,
  onReply,
}: {
  data: NeedsConnection;
  /** The member's message after this reply, if any: the conversation moved on — no 继续. */
  followUp?: string;
  /** Sends a message as the member; absent = read-only. */
  onReply?: (text: string) => Promise<boolean>;
}) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const { load, reload } = useConnectors();
  const [busy, setBusy] = useState(false);
  const [continued, setContinued] = useState(false);

  const mine = typeof load === 'object' ? load.connectors.find((row) => row.id === data.server_id) : undefined;
  const connected = mine?.status === 'connected' || mine?.status === 'not_needed';
  const name = data.server_name;
  const canAct = !!onReply;

  const body = connected
    ? t('connectors.cardConnected', { name })
    : data.reason === 'expired' || mine?.status === 'expired'
      ? t('connectors.cardExpired', { name })
      : data.auth === 'oauth'
        ? t('connectors.cardBodyOauth', { name })
        : t('connectors.cardBodyKey', { name });

  const onConnect = async () => {
    setBusy(true);
    await connect({
      id: data.server_id,
      name,
      auth_mode: data.auth,
      credential_help: mine?.credential_help ?? null,
    });
    await reload();
    setBusy(false);
  };

  const onContinue = async () => {
    if (!onReply) return;
    setContinued(true);
    if (!(await onReply(t('connectors.continueMessage', { name })))) setContinued(false);
  };

  return (
    <ChatCard variant="fill" style={styles.card}>
      <View style={styles.head}>
        <View style={[styles.tile, connected && styles.tileDone]}>
          <Icon name={connected ? 'check' : 'plug'} size={16} weight="semibold" color={connected ? c.green : c.accent} />
        </View>
        <View style={styles.texts}>
          <Text style={styles.title}>{connected ? name : t('connectors.cardTitle', { name })}</Text>
          <Text style={styles.body}>{body}</Text>
        </View>
      </View>
      {!canAct ? null : connected ? (
        !followUp && !continued ? (
          <NativeButton
            label={t('connectors.cardContinue')}
            variant="prominent"
            size="small"
            onPress={() => void onContinue()}
            style={styles.action}
          />
        ) : null
      ) : (
        <NativeButton
          label={
            data.auth === 'per_user'
              ? t('connectors.addKey')
              : data.reason === 'expired' || mine?.status === 'expired'
                ? t('connectors.reconnect')
                : t('connectors.connect')
          }
          icon={data.auth === 'per_user' ? 'key' : 'plug'}
          size="small"
          loading={busy}
          onPress={() => void onConnect()}
          style={styles.action}
        />
      )}
    </ChatCard>
  );
}

const useStyles = makeStyles((c) => ({
  card: { padding: space.md + 2, gap: space.md },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  tile: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentFill,
    ...squircle,
  },
  tileDone: { backgroundColor: c.greenFill },
  texts: { flex: 1, gap: 2 },
  title: { ...typo.subheadline, fontWeight: weight.semibold, color: c.label },
  body: { ...typo.footnote, color: c.secondaryLabel },
  action: { alignSelf: 'flex-start', marginLeft: 32 + space.md },
}));
