/**
 * An Agent's profile (`/agents/<id>` — `main` works as an id; AGNT-05, the one home of an
 * Agent): its plant, name, role and what it is for; 发消息 (its Agent thread — the main thread
 * for the main Agent), 新会话 with it, its 电脑 (when this member has computers); then 资料 —
 * the instructions and, read-only in this phase, its abilities (model, write access, skills,
 * connectors). ✎ edits it (./edit.tsx). An Agent other than the main one can be archived, an
 * archived one restored.
 *
 * Someone else's public Agent shows only what its owner shared: who shared it, its role and
 * pitch, and 发消息.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Stack, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { archiveAgent, getAgent, restoreAgent } from '../../src/api/agents';
import { createConversation } from '../../src/api/conversations';
import { useT } from '../../src/lib/i18n';
import type { AgentDetail, PublicAgent } from '../../src/shared/contract';
import { openConversation, openMainThread, openNewChat } from '../../src/shell/nav';
import { useAuth } from '../../src/store/auth';
import { useWorkspace } from '../../src/store/workspace';
import { makeStyles, space, typo, useTheme, weight } from '../../src/theme';
import { AgentAvatar } from '../../src/ui/agent-avatar';
import { NativeButton } from '../../src/ui/button';
import { alertError, confirmAction } from '../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { ListRow, ListSection } from '../../src/ui/list';
import { toast } from '../../src/ui/toast';
import { toolbarIcon } from '../../src/ui/toolbar-icon';

export default function AgentProfile() {
  const { id = '' } = useLocalSearchParams<{ id?: string }>();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const focused = useIsFocused();
  const me = useAuth((s) => s.user);
  const shared = useWorkspace((s) => s.publicAgents.find((agent) => agent.id === id) ?? null);
  const conversations = useWorkspace((s) => s.conversations);
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'failed'>('loading');
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    const result = await getAgent(id);
    if (result.ok) {
      setAgent(result.data);
      setState('ready');
    } else setState(result.status === 404 || result.status === 403 ? 'missing' : 'failed');
  }, [id]);
  // Again whenever the page comes back (an edit saved in the form sheet).
  useEffect(() => {
    if (focused) void load();
  }, [focused, load]);

  const computers = !!me?.modules.computer && !!me?.capabilities.sandbox;

  const openThread = async (target: { id: string; name: string; is_main: boolean }) => {
    if (target.is_main) {
      openMainThread(router, 'dismissTo');
      return;
    }
    const known = conversations?.find((item) => item.kind === 'direct' && item.agent_id === target.id);
    if (known) {
      openConversation(router, { id: known.id, title: target.name }, 'dismissTo');
      return;
    }
    const made = await createConversation({ kind: 'direct', agent_id: target.id });
    if (!made.ok) {
      alertError(t('directory.openFailed'), made.message || undefined);
      return;
    }
    useWorkspace.getState().putConversation(made.data);
    openConversation(router, { id: made.data.id, title: target.name }, 'dismissTo');
  };

  if (state !== 'ready' || !agent) {
    if (state === 'missing' && shared) return <SharedProfile agent={shared} onTalk={() => void openThread(shared)} />;
    return (
      <>
        <Stack.Screen options={{ title: '' }} />
        <View style={styles.center}>
          {state === 'loading' ? (
            <LoadingState />
          ) : state === 'missing' ? (
            <EmptyState icon="person" title={t('agents.missing')} />
          ) : (
            <EmptyState icon="alert" title={t('agents.loadFailed')} onRetry={() => void load()} />
          )}
        </View>
      </>
    );
  }

  const archived = !!agent.archived_at;
  const mine = agent.owner_id === me?.id;

  const archive = async () => {
    const ok = await confirmAction({
      title: t('agents.archiveTitle', { name: agent.name }),
      message: t('agents.archiveHint'),
      confirmLabel: t('row.archive'),
    });
    if (!ok) return;
    const result = await archiveAgent(agent.id);
    if (!result.ok) {
      alertError(t('agents.archiveFailed'), result.message || undefined);
      return;
    }
    toast(t('agents.archived', { name: agent.name }), 'archive');
    void useWorkspace.getState().refresh();
    void load();
  };

  const restore = async () => {
    const result = await restoreAgent(agent.id);
    if (!result.ok) {
      alertError(t('agents.restoreFailed'), result.message || undefined);
      return;
    }
    toast(t('agents.restored', { name: agent.name }), 'check');
    void useWorkspace.getState().refresh();
    setAgent(result.data);
  };

  const instructions = agent.instructions.trim();
  const long = instructions.length > 400;
  return (
    <>
      <Stack.Screen options={{ title: agent.name }} />
      {mine && !archived ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button
            icon={toolbarIcon('pen')}
            accessibilityLabel={t('agents.edit')}
            onPress={() => router.push({ pathname: '/agents/edit', params: { id: agent.id } })}
          />
        </Stack.Toolbar>
      ) : null}
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <AgentAvatar agent={agent} size={88} state={archived ? 'sleep' : undefined} animate={focused && !archived} />
          <Text style={styles.name}>{agent.name}</Text>
          <Text style={styles.role}>
            {[agent.role, agent.is_main ? t('agents.main') : ''].filter(Boolean).join(' · ')}
          </Text>
          {agent.description ? <Text style={styles.description}>{agent.description}</Text> : null}
          <View style={styles.actions}>
            <NativeButton
              label={t('agents.message')}
              icon="msg"
              variant="prominent"
              onPress={() => void openThread(agent)}
            />
            {!archived ? (
              <NativeButton
                label={t('conversation.newChat')}
                icon="compose"
                onPress={() =>
                  openNewChat(router, { agent: agent.is_main ? undefined : agent.id, compose: true }, 'dismissTo')
                }
              />
            ) : null}
            {computers && !archived ? (
              <NativeButton
                label={t('computer.title')}
                icon="computer"
                onPress={() => router.push({ pathname: '/computer', params: { agent: agent.id } })}
              />
            ) : null}
          </View>
        </View>

        {mine ? (
          <ListSection>
            <ListRow
              title={t('work.mailbox')}
              icon="at"
              accessory="chevron"
              onPress={() => router.push({ pathname: '/agents/mailbox', params: { id: agent.id } })}
            />
          </ListSection>
        ) : null}
        {mine && !archived ? (
          <ListSection>
            <ListRow
              title={t('integration.schedules')}
              icon="clock"
              accessory="chevron"
              onPress={() => router.push({ pathname: '/agents/schedules', params: { id: agent.id } })}
            />
            <ListRow
              title={t('integration.standing')}
              icon="shieldCheck"
              accessory="chevron"
              onPress={() => router.push({ pathname: '/agents/standing', params: { id: agent.id } })}
            />
          </ListSection>
        ) : null}
        <ListSection header={t('agents.instructions')}>
          <View style={styles.instructions}>
            <Text style={styles.instructionsText} selectable numberOfLines={showAll || !long ? undefined : 8}>
              {instructions || t('agents.noInstructions')}
            </Text>
            {long ? (
              <NativeButton
                label={showAll ? t('agents.showLess') : t('agents.showAll')}
                size="small"
                onPress={() => setShowAll((v) => !v)}
              />
            ) : null}
          </View>
        </ListSection>

        <ListSection header={t('agents.abilities')} footer={t('agents.abilitiesFooter')}>
          <ListRow title={t('agents.model')} value={modelLabel(t, agent.model)} />
          <ListRow title={t('agents.write')} value={agent.write ? t('agents.writeOn') : t('agents.writeOff')} />
          <ListRow title={t('agents.skills')} value={String(agent.skills.length)} />
          <ListRow
            title={t('agents.connectors')}
            value={agent.connectors === null ? t('agents.connectorsAll') : String(agent.connectors.length)}
          />
        </ListSection>

        {mine && !agent.is_main ? (
          <ListSection>
            {archived ? (
              <ListRow title={t('agents.restore')} icon="rotate" onPress={() => void restore()} />
            ) : (
              <ListRow
                title={t('row.archive')}
                icon="archive"
                iconTint={c.red}
                destructive
                onPress={() => void archive()}
              />
            )}
          </ListSection>
        ) : null}
      </ScrollView>
    </>
  );
}

function modelLabel(t: ReturnType<typeof useT>, model: string): string {
  if (model === 'default') return t('agents.modelDefault');
  if (model === 'strong') return t('agents.modelStrong');
  if (model === 'fast') return t('agents.modelFast');
  return model.split('/').pop() ?? model;
}

/** Someone else's public Agent: only what its owner shared. */
function SharedProfile({ agent, onTalk }: { agent: PublicAgent; onTalk: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  return (
    <>
      <Stack.Screen options={{ title: agent.name }} />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <AgentAvatar agent={agent} size={88} />
          <Text style={styles.name}>{agent.name}</Text>
          <Text style={styles.role}>
            {[agent.role, t('directory.sharedBy', { name: agent.owner.name })].filter(Boolean).join(' · ')}
          </Text>
          {agent.description ? <Text style={styles.description}>{agent.description}</Text> : null}
          <View style={styles.actions}>
            <NativeButton label={t('agents.message')} icon="msg" variant="prominent" onPress={onTalk} />
          </View>
          <Text style={styles.note}>{t('agents.publicNote', { name: agent.owner.name })}</Text>
        </View>
      </ScrollView>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  center: { flex: 1, justifyContent: 'center' },
  content: { paddingBottom: space.xxxl },
  hero: {
    alignItems: 'center',
    paddingHorizontal: space.xxl,
    paddingTop: space.lg,
    paddingBottom: space.lg,
    gap: space.xs,
  },
  name: { ...typo.title2, fontWeight: weight.semibold, color: c.label, marginTop: space.sm, textAlign: 'center' },
  role: { ...typo.subheadline, color: c.secondaryLabel, textAlign: 'center' },
  description: { ...typo.body, color: c.label, textAlign: 'center', marginTop: space.xs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: space.sm, marginTop: space.md },
  note: { ...typo.footnote, color: c.tertiaryLabel, textAlign: 'center', marginTop: space.md },
  instructions: { padding: space.md, gap: space.sm, alignItems: 'flex-start' },
  instructionsText: { ...typo.subheadline, color: c.label },
}));
