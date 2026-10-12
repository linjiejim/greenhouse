/**
 * `/bots/agents` — "Browse Agents": the public Agents other members shared with this one
 * (`GET /api/agents`; spec docs/specs/20261011-agent-first-class.md §5c P4). Reached from the
 * drawer's Agent section ("Browse Agents ›", shown while any are offered). Each row is the Agent's
 * plant, its name, its role and who shared it, and what it is for; "Talk" opens the member's own
 * DM with it — made, greeting included, the first time (`POST /api/agents/:id/conversation`) —
 * and closes the sheet onto that thread. One the member already talks to says "Open".
 *
 * Its owner sees how much it is used and the member's ratings, never the conversation (D38): the
 * list's footer says so. Publishing is the web's (no publishing here). The native search bar
 * filters by name, role, description and owner. Pull to refresh; a failed first read is a retry
 * state, a server without public Agents says so.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { openThread } from '../../src/bots/nav';
import { directoryRows } from '../../src/bots/public-agents';
import { BotsRouteGate } from '../../src/bots/route-gate';
import { useBots } from '../../src/bots/store';
import { BotAvatar } from '../../src/bots/ui/bot-avatar';
import type { SharedBotView } from '../../src/shared/bots';
import { useT } from '../../src/lib/i18n';
import { makeStyles, space, typo, useTheme } from '../../src/theme';
import { NativeButton } from '../../src/ui/button';
import { alertError } from '../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { ListRow, ListSection } from '../../src/ui/list';
import { SheetClose } from '../../src/ui/sheet-chrome';

/** Leading column: a 40-pt plant. */
const LEAD_W = 48;

/** Closed Bots (Android, switched off, refused) → home: src/bots/route-gate.tsx. */
export default function AgentsRoute() {
  return (
    <BotsRouteGate kind="threads">
      <AgentsSheet />
    </BotsRouteGate>
  );
}

function AgentsSheet() {
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();

  const agents = useBots((s) => s.directory);
  const state = useBots((s) => s.directoryState);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  /** The Agent whose conversation is being opened (one at a time; the row and its button share it). */
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    void useBots.getState().loadDirectory();
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await useBots.getState().loadDirectory();
    setRefreshing(false);
  }, []);

  const rows = useMemo(() => directoryRows(agents, query), [agents, query]);

  const talk = useCallback(
    async (agent: SharedBotView) => {
      if (opening) return;
      if (agent.dm_session_id) {
        openThread(router, { c: agent.dm_session_id, title: agent.name }, 'dismissTo');
        return;
      }
      setOpening(agent.id);
      const result = await useBots.getState().startAgentChat(agent);
      setOpening(null);
      if (result.ok) {
        openThread(router, { c: result.sessionId, title: agent.name }, 'dismissTo');
        return;
      }
      alertError(
        result.reason === 'gone'
          ? t('bots.agents.gone', { name: agent.name })
          : t('bots.agents.startFailed', { name: agent.name }),
        result.reason === 'offline' ? t('bots.card.err.network') : undefined,
      );
    },
    [opening, router, t],
  );

  const loaded = state === 'loaded';
  return (
    <>
      <Stack.Screen options={{ title: t('bots.agents.title') }} />
      {loaded && agents.length > 0 ? (
        <Stack.SearchBar
          placeholder={t('drawer.search')}
          onChangeText={(e) => setQuery(e.nativeEvent.text)}
          onCancelButtonPress={() => setQuery('')}
          tintColor={hex.accent}
          autoCapitalize="none"
          hideWhenScrolling={false}
        />
      ) : null}
      <SheetClose />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={hex.accent} />
        }
      >
        {state === 'missing' ? (
          <EmptyState
            icon="users"
            title={t('bots.agents.missing')}
            message={t('bots.agents.missingHint')}
            style={styles.centered}
          />
        ) : !loaded ? (
          state === 'failed' ? (
            <EmptyState
              icon="alert"
              title={t('bots.agents.loadFailed')}
              onRetry={() => void useBots.getState().loadDirectory()}
              style={styles.centered}
            />
          ) : (
            <LoadingState />
          )
        ) : agents.length === 0 ? (
          <EmptyState
            icon="users"
            title={t('bots.agents.empty')}
            message={t('bots.agents.emptyHint')}
            style={styles.centered}
          />
        ) : rows.length === 0 ? (
          <EmptyState icon="search" title={t('bots.agents.noMatch')} style={styles.centered} />
        ) : (
          <ListSection footer={t('bots.agents.footer')}>
            {rows.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                opening={opening === agent.id}
                disabled={!!opening && opening !== agent.id}
                onTalk={talk}
              />
            ))}
          </ListSection>
        )}
      </ScrollView>
    </>
  );
}

/** One public Agent: plant · name · role and owner · what it is for · Talk (Open once there is a DM). */
function AgentRow({
  agent,
  opening,
  disabled,
  onTalk,
}: {
  agent: SharedBotView;
  opening: boolean;
  disabled: boolean;
  onTalk: (agent: SharedBotView) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const by = t('bots.agents.byOwner', { name: agent.owner.nickname });
  const subtitle = [agent.role.trim(), by].filter(Boolean).join(' · ');
  const description = agent.description.trim();
  const label = agent.dm_session_id ? t('bots.agents.open') : t('bots.agents.talk');
  const press = () => onTalk(agent);
  return (
    <ListRow
      title={agent.name}
      subtitle={subtitle}
      subtitleLines={1}
      leading={
        <View style={styles.lead}>
          <BotAvatar bot={agent} size={40} animate={false} />
        </View>
      }
      leadingWidth={LEAD_W}
      accessory={
        <NativeButton
          label={label}
          size="small"
          variant={agent.dm_session_id ? 'tinted' : 'prominent'}
          loading={opening}
          disabled={disabled}
          onPress={press}
        />
      }
      footer={
        description ? (
          <Text style={styles.description} numberOfLines={3}>
            {description}
          </Text>
        ) : undefined
      }
      onPress={press}
      accessibilityLabel={[agent.name, subtitle, description, label].filter(Boolean).join(t('bots.nav.listSep'))}
    />
  );
}

const useStyles = makeStyles((c) => ({
  content: { paddingTop: space.sm, paddingBottom: space.xxxl, flexGrow: 1 },
  centered: { flexGrow: 1, justifyContent: 'center' },
  lead: { width: LEAD_W, alignItems: 'center' },
  description: { ...typo.footnote, color: c.secondaryLabel, paddingRight: space.margin, paddingBottom: space.sm },
}));
