/**
 * `/computer?agent=&request=&control=` — an Agent's computer on the phone (AGNT-18, AGNT-19): my
 * copy of it (each Agent has its own; a public Agent's users each get theirs).
 *
 *   ✕  Greeny's computer              status line under the bar
 *   [ Screen | Files | Processes ]
 *   (card banner: what the Agent asked for · [Hand back])
 *   live screen (src/computer) ← pinch / two fingers zoom and move
 *   control bar: watching → Take over · in control → keys, Type, Hand back
 *
 * Watching and taking over are the same picture: taking over reconnects with a `control`
 * ticket. Handing back settles the take-over or sign-in card the page was opened for (or the
 * oldest one of this Agent's computer) with an optional note the Agent reads when it wakes, then
 * goes back to watching. `control=1` (a card's 接管电脑 / 我自己登录) takes over on arrival.
 * Closing while in control asks first. Full-screen modal, no swipe to dismiss: fingers on the
 * screen are the computer's.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { handBack as handBackRequest, listRequests } from '../src/api/requests';
import { ComputerScreenView } from '../src/computer/computer-screen';
import { ControlBar } from '../src/computer/control-bar';
import { FilesTab } from '../src/computer/files-tab';
import { cardToAnswer } from '../src/computer/model';
import { ProcessesTab } from '../src/computer/processes-tab';
import { useComputer } from '../src/computer/use-computer';
import { useComputerScreen } from '../src/computer/use-computer-screen';
import { useT } from '../src/lib/i18n';
import { relativeTimeNow } from '../src/lib/time-words';
import type { NeedsYou } from '../src/shared/contract';
import { useThreads } from '../src/store/threads';
import { useWorkspace } from '../src/store/workspace';
import { makeStyles, radius, space, typo, useTheme, weight } from '../src/theme';
import { NativeButton } from '../src/ui/button';
import { alertError, promptText } from '../src/ui/dialogs';
import { EmptyState, LoadingState } from '../src/ui/empty';
import { notifySuccess } from '../src/ui/haptics';
import { useHeaderInset } from '../src/ui/header-inset';
import { Segmented } from '../src/ui/segmented';
import { SheetClose } from '../src/ui/sheet-chrome';
import { toast } from '../src/ui/toast';

type Tab = 'screen' | 'files' | 'processes';

export default function ComputerPage() {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const headerInset = useHeaderInset();
  const params = useLocalSearchParams<{ agent?: string; request?: string; control?: string }>();
  const agentId = params.agent ?? '';
  const agentName = useWorkspace(
    (s) =>
      s.agents?.find((agent) => agent.id === agentId)?.name ?? s.publicAgents.find((agent) => agent.id === agentId)?.name,
  );
  const name = agentName ?? t('conversation.anAgent');
  const { computer, failed, busy, refresh, act } = useComputer(agentId);
  const running = computer?.state === 'running';
  const [tab, setTab] = useState<Tab>('screen');
  const [control, setControl] = useState(params.control === '1');
  const [since, setSince] = useState<number | null>(params.control === '1' ? Date.now() : null);
  const [handing, setHanding] = useState(false);
  const [hintAt, setHintAt] = useState(0);

  // The card a hand-back settles: from the threads (live) or the pending list.
  const fromThreads = useThreads((s) => Object.values(s.threads).flatMap((entry) => entry.requests));
  const [pending, setPending] = useState<NeedsYou[]>([]);
  const loadPending = useCallback(async () => {
    const result = await listRequests({ state: 'pending', limit: 200 });
    if (result.ok) setPending(result.data.items);
  }, []);
  useEffect(() => {
    void loadPending();
  }, [loadPending]);
  const card = useMemo(
    () => cardToAnswer([...fromThreads, ...pending], { requestId: params.request, agentId }),
    [fromThreads, pending, params.request, agentId],
  );

  const screen = useComputerScreen({
    agentId,
    enabled: tab === 'screen' && running,
    control,
    onTapWhileWatching: () => setHintAt(Date.now()),
    onDisconnected: () => void refresh(),
  });

  const takeOver = useCallback(() => {
    setControl(true);
    setSince(Date.now());
    setTab('screen');
    toast(t('computer.gestureHint'), 'hand');
  }, [t]);

  /** Hand back: settle the card (with a note for the Agent) and go back to watching. */
  const handBack = useCallback(
    async (note?: string): Promise<boolean> => {
      if (card) {
        setHanding(true);
        const result = await handBackRequest(card.id, note);
        setHanding(false);
        if (!result.ok && result.status !== 409) {
          alertError(t('computer.handBackFailed'), result.message || undefined);
          return false;
        }
        if (card.conversation_id) void useThreads.getState().refreshRequests(card.conversation_id);
        void useWorkspace.getState().refreshSummary();
        void loadPending();
        notifySuccess();
      }
      setControl(false);
      setSince(null);
      toast(t('computer.handedBack'), 'check');
      return true;
    },
    [card, loadPending, t],
  );

  const askHandBack = useCallback(() => {
    if (!card) {
      void handBack();
      return;
    }
    Alert.alert(t('computer.handBackTitle'), t('computer.handBackDesc', { name }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('computer.handBackWithNote'),
        onPress: () =>
          void promptText({ title: t('computer.noteTitle', { name }), placeholder: t('computer.notePlaceholder') }).then(
            (note) => {
              if (note) void handBack(note);
            },
          ),
      },
      { text: t('computer.handBack'), onPress: () => void handBack() },
    ]);
  }, [card, handBack, name, t]);

  const type = useCallback(async () => {
    const text = await promptText({
      title: t('computer.typeTitle'),
      message: t('computer.typeHelp'),
      confirmLabel: t('computer.typeSend'),
    });
    if (!text) return;
    screen.type(text);
    toast(t('computer.typeSent'), 'check');
  }, [screen, t]);

  const close = useCallback(() => {
    if (!control || !card) {
      router.back();
      return;
    }
    Alert.alert(t('computer.closeInControlTitle'), t('computer.closeInControlDesc', { name }), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('computer.keepControl'), onPress: () => router.back() },
      {
        text: t('computer.closeHandBack'),
        onPress: () =>
          void handBack().then((ok) => {
            if (ok) router.back();
          }),
      },
    ]);
  }, [card, control, handBack, name, router, t]);

  const start = async () => {
    const result = await act('start');
    if (!result.ok) {
      alertError(
        t('computer.startFailed'),
        result.code === 'computers_full' ? t('computer.full') : result.message || undefined,
      );
    }
  };

  const tabs = [
    { value: 'screen' as const, label: t('computer.screen') },
    { value: 'files' as const, label: t('computer.files') },
    { value: 'processes' as const, label: t('computer.processes') },
  ];
  const stateWord = computer ? t(`computer.state.${computer.state}`) : t('common.loading');
  const stateColor =
    computer?.state === 'running' ? (control ? c.accent : c.green) : computer?.state === 'failed' ? c.red : computer?.state === 'starting' ? c.blue : c.gray;

  return (
    <View style={[styles.root, { paddingTop: headerInset }]}>
      <Stack.Screen options={{ title: agentName ? t('computer.titleOf', { name: agentName }) : t('computer.title') }} />
      <SheetClose onPress={close} />
      <View style={styles.head}>
        <View style={styles.status} accessible accessibilityRole="text">
          <View style={[styles.dot, { backgroundColor: stateColor }]} />
          <Text style={styles.statusText} numberOfLines={1}>
            {[running && control ? t('computer.controlling') : running ? t('computer.watching') : stateWord, computer?.last_active_at ? relativeTimeNow(computer.last_active_at) : '']
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </View>
        <Segmented value={tab} options={tabs} onChange={setTab} />
      </View>
      {card ? (
        <View style={styles.banner} accessibilityRole="alert">
          <Text style={styles.bannerText}>{card.title}</Text>
          {typeof card.payload.reason === 'string' && card.payload.reason ? (
            <Text style={styles.bannerReason}>{card.payload.reason}</Text>
          ) : null}
          <View style={styles.bannerButtons}>
            {!control && running ? <NativeButton label={t('computer.takeOver')} size="small" onPress={takeOver} /> : null}
            <NativeButton
              label={t('computer.handBack')}
              size="small"
              variant={control ? 'prominent' : 'tinted'}
              loading={handing}
              onPress={askHandBack}
            />
          </View>
        </View>
      ) : null}
      <View style={styles.body}>
        {failed && !computer ? (
          <EmptyState icon="alertCircle" title={failed.message || t('computer.loadFailed')} onRetry={() => void refresh()} style={styles.fill} />
        ) : !computer ? (
          <LoadingState style={styles.fill} />
        ) : tab === 'files' ? (
          <FilesTab agentId={agentId} />
        ) : tab === 'processes' ? (
          <ProcessesTab agentId={agentId} />
        ) : running ? (
          <ComputerScreenView screen={screen} hintAt={hintAt} onTakeOver={takeOver} />
        ) : computer.state === 'starting' ? (
          <EmptyState icon="computer" title={t('computer.state.starting')} message={t('computer.startingDesc')} style={styles.fill} />
        ) : (
          <EmptyState
            icon={computer.state === 'failed' ? 'alertCircle' : 'sleep'}
            title={stateWord}
            message={computer.state_reason ?? t('computer.stoppedDesc', { name })}
            action={<NativeButton label={t('computer.start')} variant="prominent" loading={busy === 'start'} onPress={() => void start()} />}
            style={styles.fill}
          />
        )}
      </View>
      {tab === 'screen' && running ? (
        <ControlBar
          inControl={control}
          since={since}
          busy={handing ? 'handback' : null}
          bottomInset={insets.bottom}
          onTakeOver={takeOver}
          onHandBack={askHandBack}
          onType={() => void type()}
          onKey={screen.sendKey}
          onZoom={screen.setZoom}
        />
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.background },
  head: { paddingHorizontal: space.margin, paddingTop: space.sm, paddingBottom: space.md, gap: space.md },
  status: { flexDirection: 'row', alignItems: 'center', gap: space.sm, alignSelf: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { ...typo.footnote, color: c.secondaryLabel },
  body: { flex: 1 },
  fill: { flex: 1, justifyContent: 'center' },
  banner: {
    marginHorizontal: space.margin,
    marginBottom: space.md,
    padding: space.md,
    gap: space.sm,
    borderRadius: radius.md,
    backgroundColor: c.accentFill,
  },
  bannerText: { ...typo.subheadline, fontWeight: weight.medium, color: c.label },
  bannerReason: { ...typo.footnote, color: c.secondaryLabel },
  bannerButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm },
}));
