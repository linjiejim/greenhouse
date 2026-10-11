/**
 * `/bots/computer?c=&request=&control=` — the member's computer on the phone
 * (spec docs/specs/20261011-mobile-computer.md): one computer per member,
 * shared by all their Bots, so it opens from a thread's bar and from the
 * cards that need a hand on it — never from one Bot's profile.
 *
 *   ✕  Computer                       status line under the bar
 *   [ Screen | Files | Processes ]
 *   (card banner: "… then tap Done"  [Skip] [Done])
 *   live screen (./src/bots/computer)  ← pinch / two fingers zoom and move
 *   control bar: watching → Take Over · in control → keys, Type, Hand Back
 *
 * - `c`: the conversation it was opened from — a plain hand-back settles the
 *   one card waiting there (the server never guesses across conversations).
 * - `request`: the card it was opened for; `control=1`: take over on arrival
 *   (the card's "Verify" / "Take Over").
 * - Closing while in control asks first (hand back / keep control), as the web
 *   pane does: the Bots cannot use the computer meanwhile.
 * - Full-screen modal, no swipe to dismiss: fingers on the screen are the
 *   computer's.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { handbackComputer, takeoverComputer, typeIntoComputer } from '../../src/api/bots';
import { useBotName } from '../../src/bots/cards/card-frame';
import { ComputerScreenView } from '../../src/bots/computer/computer-screen';
import { ControlBar } from '../../src/bots/computer/control-bar';
import { computerErrorKey } from '../../src/bots/computer/errors';
import { FilesTab } from '../../src/bots/computer/files-tab';
import { cardToAnswer, needsKey } from '../../src/bots/computer/model';
import { ProcessesTab } from '../../src/bots/computer/processes-tab';
import { useComputerScreen } from '../../src/bots/computer/use-computer-screen';
import { useComputerStatus } from '../../src/bots/computer/use-computer-status';
import { BotsRouteGate } from '../../src/bots/route-gate';
import { useBots } from '../../src/bots/store';
import { phaseLabelKey, reasonKey, type ComputerPhase } from '../../src/bots/vendor/computer-phase';
import type { BotRequestView } from '../../src/shared/bots';
import { useT, type TFunction } from '../../src/lib/i18n';
import { makeStyles, radius, space, typo, useTheme, weight } from '../../src/theme';
import { NativeButton } from '../../src/ui/button';
import { alertError, promptText } from '../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { useHeaderInset } from '../../src/ui/header-inset';
import { notifySuccess } from '../../src/ui/haptics';
import { Segmented } from '../../src/ui/segmented';
import { SheetClose } from '../../src/ui/sheet-chrome';
import { toast } from '../../src/ui/toast';

type Tab = 'screen' | 'files' | 'processes';
type Busy = 'takeover' | 'handback' | 'type' | 'start' | null;

export default function ComputerRoute() {
  return (
    <BotsRouteGate kind="threads">
      <ComputerPage />
    </BotsRouteGate>
  );
}

function ComputerPage() {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // the bar is glass over the page, as everywhere: start below it
  const headerInset = useHeaderInset();
  const params = useLocalSearchParams<{ c?: string; request?: string; control?: string }>();
  const sessionId = params.c || undefined;
  const computer = useComputerStatus(true);
  const { phase } = computer;
  const inControl = phase?.kind === 'running' && phase.controller === 'user';
  const [tab, setTab] = useState<Tab>('screen');
  const [busy, setBusy] = useState<Busy>(null);
  const [hintAt, setHintAt] = useState(0);

  const pending = useBots((s) => s.pendingRequests);
  const loadPending = useBots((s) => s.loadPending);
  const decide = useBots((s) => s.decide);
  useEffect(() => {
    void loadPending();
  }, [loadPending]);
  const card = cardToAnswer(pending, { requestId: params.request, sessionId });

  const screen = useComputerScreen({
    enabled: tab === 'screen' && phase?.kind === 'running',
    viewOnly: !inControl,
    onTapWhileWatching: () => setHintAt(Date.now()),
    onDisconnected: () => void computer.refresh(),
  });

  const fail = useCallback(
    (title: string, code: string | null) => {
      const key = computerErrorKey(code);
      alertError(title, key ? t(key) : undefined);
      void computer.refresh();
    },
    [computer, t],
  );

  const takeOver = useCallback(async () => {
    setBusy('takeover');
    const result = await takeoverComputer();
    setBusy(null);
    if (result.ok) {
      computer.apply(result.value);
      setTab('screen');
      // how fingers work in control (they pan and zoom while watching)
      toast(t('bots.computer.gestureHint'), 'hand');
    } else if (result.code !== 'user_in_control') fail(t('bots.computer.takeOverFailed'), result.code);
  }, [computer, fail, t]);

  // The card's "Verify" / "Take Over": take the computer once, on arrival.
  const tookOnArrival = useRef(false);
  useEffect(() => {
    if (params.control !== '1' || tookOnArrival.current || !phase) return;
    if (phase.kind === 'unavailable' || phase.kind === 'checking') return;
    tookOnArrival.current = true;
    if (!inControl) void takeOver();
  }, [params.control, phase, inControl, takeOver]);

  /** Hand back — settling the card the page answers (or the one waiting in this conversation). */
  const handBack = useCallback(
    async (note?: string): Promise<boolean> => {
      setBusy('handback');
      const result = await handbackComputer({
        note,
        requestId: card?.id,
        sessionId: card?.session_id ?? sessionId,
      });
      setBusy(null);
      if (!result.ok) {
        fail(t('bots.computer.handBackFailed'), result.code);
        return false;
      }
      computer.apply(result.value);
      notifySuccess();
      toast(t('bots.computer.handedBack'), 'check');
      void loadPending();
      return true;
    },
    [card, sessionId, computer, fail, loadPending, t],
  );

  const askHandBack = useCallback(() => {
    Alert.alert(t('bots.computer.handBackTitle'), t('bots.computer.handBackDesc'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('bots.computer.handBackWithNote'),
        onPress: () =>
          void promptText({ title: t('bots.computer.noteTitle'), placeholder: t('bots.computer.notePlaceholder') }).then(
            (note) => {
              if (note) void handBack(note);
            },
          ),
      },
      { text: t('bots.computer.handBack'), style: 'default', onPress: () => void handBack() },
    ]);
  }, [handBack, t]);

  const type = useCallback(async () => {
    const text = await promptText({ title: t('bots.computer.typeTitle'), message: t('bots.computer.typeHelp'), confirmLabel: t('bots.computer.typeSend') });
    if (!text) return;
    setBusy('type');
    const result = await typeIntoComputer(text);
    setBusy(null);
    if (result.ok) toast(t('bots.computer.typeSent'), 'check');
    else fail(t('bots.computer.typeFailed'), result.code);
  }, [fail, t]);

  const skip = useCallback(
    async (request: BotRequestView) => {
      const outcome = await decide(request, { decision: 'deny' });
      if (outcome.kind === 'ok' || outcome.kind === 'stale') router.back();
      else if (outcome.kind === 'refused') alertError(t('bots.card.failedTitle'));
    },
    [decide, router, t],
  );

  const close = useCallback(() => {
    if (!inControl) {
      router.back();
      return;
    }
    Alert.alert(t('bots.computer.closeInControlTitle'), t('bots.computer.closeInControlDesc'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('bots.computer.keepControl'), onPress: () => router.back() },
      {
        text: t('bots.computer.closeHandBack'),
        onPress: () =>
          void handBack().then((ok) => {
            if (ok) router.back();
          }),
      },
    ]);
  }, [handBack, inControl, router, t]);

  const start = useCallback(async () => {
    setBusy('start');
    const ok = await computer.start();
    setBusy(null);
    if (!ok) alertError(t('bots.computer.startFailed'));
  }, [computer, t]);

  const tabs = [
    { value: 'screen' as const, label: t('bots.computer.tabScreen') },
    { value: 'files' as const, label: t('bots.computer.tabFiles') },
    { value: 'processes' as const, label: t('bots.computer.tabProcesses') },
  ];
  const running = phase?.kind === 'running';

  return (
    <View style={[styles.root, { paddingTop: headerInset }]}>
      <Stack.Screen options={{ title: t('bots.computer.title') }} />
      <SheetClose onPress={close} />
      <View style={styles.head}>
        <StatusLine phase={phase} loading={!phase && !computer.loadError} t={t} />
        <Segmented value={tab} options={tabs} onChange={setTab} />
      </View>
      {card ? (
        <NeedsBanner
          request={card}
          busy={busy === 'handback'}
          inControl={inControl}
          onDone={() =>
            void handBack().then((ok) => {
              if (ok) router.back();
            })
          }
          onSkip={() => void skip(card)}
        />
      ) : null}
      <View style={styles.body}>
        {computer.loadError ? (
          <EmptyState icon="alertCircle" title={t('bots.computer.loadFailed')} onRetry={() => void computer.refresh()} style={styles.fill} />
        ) : !phase ? (
          <LoadingState style={styles.fill} />
        ) : tab === 'files' ? (
          <FilesTab />
        ) : tab === 'processes' ? (
          <ProcessesTab />
        ) : running ? (
          <ComputerScreenView screen={screen} hintAt={hintAt} onTakeOver={() => void takeOver()} />
        ) : (
          <NotRunning phase={phase} starting={busy === 'start' || computer.starting} onStart={() => void start()} t={t} />
        )}
      </View>
      {tab === 'screen' && running ? (
        <ControlBar
          inControl={inControl}
          since={phase.kind === 'running' ? phase.since : null}
          busy={busy === 'start' ? null : busy}
          bottomInset={insets.bottom}
          onTakeOver={() => void takeOver()}
          onHandBack={askHandBack}
          onType={() => void type()}
          onKey={screen.sendKey}
          onZoom={screen.setZoom}
        />
      ) : null}
    </View>
  );
}

function StatusLine({ phase, loading, t }: { phase: ComputerPhase | null; loading: boolean; t: TFunction }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const label = phase ? t(phaseLabelKey(phase)) : loading ? t('bots.computer.stateLoading') : '';
  const color =
    phase?.kind === 'running'
      ? phase.controller === 'user'
        ? c.accent
        : c.green
      : phase?.kind === 'error'
        ? c.red
        : phase && ['starting', 'queued', 'stopping', 'checking'].includes(phase.kind)
          ? c.blue
          : c.gray;
  return (
    <View style={styles.status} accessible accessibilityRole="text">
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={styles.statusText} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function NeedsBanner({
  request,
  busy,
  inControl,
  onDone,
  onSkip,
}: {
  request: BotRequestView;
  busy: boolean;
  inControl: boolean;
  onDone: () => void;
  onSkip: () => void;
}) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const name = useBotName(request.bot_id);
  return (
    <View style={styles.banner} accessibilityRole="alert">
      <Text style={styles.bannerText}>{t(needsKey(request), { name })}</Text>
      <View style={styles.bannerButtons}>
        <NativeButton label={t('bots.computer.skip')} size="small" onPress={onSkip} disabled={busy} />
        <NativeButton
          label={t('bots.computer.done')}
          size="small"
          variant={inControl ? 'prominent' : 'tinted'}
          loading={busy}
          onPress={onDone}
        />
      </View>
    </View>
  );
}

function NotRunning({
  phase,
  starting,
  onStart,
  t,
}: {
  phase: ComputerPhase;
  starting: boolean;
  onStart: () => void;
  t: TFunction;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  if (phase.kind === 'unavailable') {
    return <EmptyState icon="computer" title={t('bots.computer.stateUnavailable')} message={t('bots.computer.unavailableDesc')} style={styles.fill} />;
  }
  if (phase.kind === 'starting' || phase.kind === 'checking' || phase.kind === 'stopping') {
    return (
      <EmptyState
        icon="computer"
        title={t(phaseLabelKey(phase))}
        message={phase.kind === 'starting' ? t('bots.computer.startingDesc') : undefined}
        style={styles.fill}
      />
    );
  }
  if (phase.kind === 'queued') {
    return (
      <EmptyState
        icon="hourglass"
        title={t('bots.computer.stateQueued')}
        message={t('bots.computer.queuedDesc', { position: phase.position })}
        style={styles.fill}
      />
    );
  }
  const reason = phase.kind === 'asleep' || phase.kind === 'error' ? reasonKey(phase.reason) : null;
  return (
    <EmptyState
      icon={phase.kind === 'error' ? 'alertCircle' : 'sleep'}
      title={t(phaseLabelKey(phase))}
      message={reason ? t(reason) : t('bots.computer.asleepDesc')}
      action={<NativeButton label={t('bots.computer.start')} variant="prominent" loading={starting} onPress={onStart} />}
      style={styles.fill}
    />
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
  bannerButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm },
}));
