/**
 * A new chat (CONV-03, CONV-29): the answering Agent's plant (it answers a tap), a greeting,
 * three starters and the composer. `@` picks the Agent that answers (the main Agent by
 * default); starters are my most-used skills for that Agent, else its template's opening lines.
 * The chat exists from the first message on: the first send creates it, sends, and the home
 * route turns into that conversation.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useIsFocused, useNavigation, useRouter } from 'expo-router';
import { DrawerActions } from 'expo-router/react-navigation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeIn, useAnimatedStyle } from 'react-native-reanimated';
import { KeyboardStickyView, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { createConversation, getConversation, sendMessage } from '../api/conversations';
import { skillStarters } from '../api/me';
import { badgeOf } from '../data/directory';
import { useComposerBridge } from '../chat/composer-bridge';
import { MAX_FILES } from '../chat/composer-files';
import { Composer } from '../chat/composer';
import { HeroAvatar } from '../chat/hero-avatar';
import { greeting } from '../lib/format';
import { t as tNow, useT } from '../lib/i18n';
import type { Skill } from '../shared/contract';
import { openConversation } from '../shell/nav';
import { useAuth } from '../store/auth';
import { useSkillsFor } from '../store/skills';
import { useThreads } from '../store/threads';
import { useWorkspace } from '../store/workspace';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { Icon } from '../ui/core';
import { alertError } from '../ui/dialogs';
import { useHeaderInset } from '../ui/header-inset';
import { PickerStrip, SkillFields, type CandidateFace } from './composer-accessory';
import { ConversationHeader, type HeaderModel } from './header';
import { newChatSendState, sendNewChat } from './new-chat-send';
import type { MentionCandidate } from './picker';
import { useComposer } from './use-composer';

export function NewChatScreen({ agentId, compose }: { agentId: string; compose: boolean }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderInset();
  const focused = useIsFocused();
  const me = useAuth((s) => s.user)!;
  const agents = useWorkspace((s) => s.agents);
  const summary = useWorkspace((s) => s.summary);
  const [picked, setPicked] = useState<string | null>(null);
  const chosenId = picked ?? (agentId && agentId !== 'main' ? agentId : null);
  const main = agents?.find((agent) => agent.is_main) ?? null;
  const answering = chosenId ? (agents?.find((agent) => agent.id === chosenId) ?? null) : main;
  const targetId = chosenId ?? main?.id ?? null;
  const agentKey = answering?.is_main ? 'main' : (chosenId ?? 'main');
  const [sending, setSending] = useState(false);
  const pending = useRef(newChatSendState());
  const attaching = useRef(false);
  const lifetime = useRef({ mounted: true, focused, epoch: 0 });
  if (lifetime.current.focused !== focused) {
    lifetime.current.focused = focused;
    lifetime.current.epoch += 1;
  }
  useEffect(() => {
    const page = lifetime.current;
    page.mounted = true;
    return () => {
      page.mounted = false;
      page.epoch += 1;
    };
  }, []);

  const candidates = useMemo<MentionCandidate[]>(
    () =>
      (agents ?? [])
        .filter((agent) => !agent.archived_at)
        .map((agent) => ({ handle: agent.id, name: agent.name, hint: agent.role })),
    [agents],
  );
  const faces = useCallback(
    (handle: string): CandidateFace | undefined => {
      const agent = agents?.find((item) => item.id === handle);
      return agent ? { agent } : undefined;
    },
    [agents],
  );
  const skills = useSkillsFor(agentKey) ?? NO_SKILLS;
  const composer = useComposer({
    conversationId: null,
    candidates,
    mentionMode: 'switch',
    onSwitch: (candidate) => setPicked(candidate.handle),
    skills,
  });

  const selectedSkill = useComposerBridge((s) => s.skill);
  const chooseSkill = composer.chooseSkill;
  useEffect(() => {
    if (!focused || sending || pending.current.sending || !selectedSkill) return;
    useComposerBridge.setState({ skill: null });
    chooseSkill(selectedSkill);
  }, [focused, selectedSkill, chooseSkill, sending]);

  // Starters: my skills for this Agent, else its template's opening lines.
  const [starters, setStarters] = useState<{ skills: Skill[]; lines: string[] } | null>(null);
  useEffect(() => {
    let live = true;
    setStarters(null);
    void skillStarters(agentKey === 'main' ? undefined : agentKey).then((result) => {
      if (live && result.ok) setStarters({ skills: result.data.skills, lines: result.data.starters });
    });
    return () => {
      live = false;
    };
  }, [agentKey]);

  const [composerH, setComposerH] = useState(60);
  const composerBottom = Math.max(insets.bottom, space.md) + (Platform.OS === 'android' ? space.sm : 0);
  const stickyOffset = useMemo(() => ({ closed: 0, opened: insets.bottom - space.sm }), [insets.bottom]);
  const { height: kbHeight } = useReanimatedKeyboardAnimation();
  const heroLift = useAnimatedStyle(() => ({
    transform: [{ translateY: -Math.max(0, Math.abs(kbHeight.value) - insets.bottom) / 2 }],
  }));

  const { build, take } = composer;
  const send = useCallback(async () => {
    if (pending.current.sending || attaching.current || !lifetime.current.focused) return;
    const built = build();
    if (!built) return;
    if ('tooManyFiles' in built) {
      alertError(tNow('composer.maxFiles', { n: MAX_FILES }));
      return;
    }
    if ('missing' in built) {
      alertError(tNow('composer.required', { name: built.missing }));
      return;
    }
    const generation = useWorkspace.getState().generation;
    const epoch = lifetime.current.epoch;
    const current = () => lifetime.current.mounted && generation === useWorkspace.getState().generation;
    const active = () => current() && lifetime.current.focused && lifetime.current.epoch === epoch;
    // Keep the submitted draft visible and lock every input until this HTTP action settles.
    // Failures and a focus change then need no restore, and cannot overwrite a newer draft.
    setSending(true);
    Keyboard.dismiss();
    try {
      const result = await sendNewChat(pending.current, targetId, built.input, {
        current,
        active,
        create: createConversation,
        send: sendMessage,
        read: getConversation,
        remember: (chat) => useWorkspace.getState().putConversation(chat),
      });
      if (!current()) return;
      if (result.status === 'sent') {
        take();
        if (active()) {
          // Thread reads carry their own workspace generation guard.
          void useThreads.getState().open(result.conversationId);
          openConversation(router, { id: result.conversationId });
        }
      } else if (result.status === 'failed' && active()) {
        alertError(
          tNow(result.stage === 'create' ? 'conversation.createFailed' : 'conversation.sendFailed'),
          result.error.message || undefined,
        );
      }
    } finally {
      if (current()) setSending(false);
    }
  }, [build, take, targetId, router]);

  const headerModel = useMemo<HeaderModel>(
    () => ({
      title: t('conversation.newChat'),
      status: answering && !answering.is_main ? answering.name : '',
      agent: answering,
      kind: 'new',
      pinned: false,
      muted: false,
      unread: false,
      computer: false,
      badge: badgeOf(summary),
    }),
    [t, answering, summary],
  );

  const accessory = sending ? null : composer.picker.length ? (
    <PickerStrip
      entries={composer.picker}
      faces={faces}
      onPick={(entry) => {
        if (!pending.current.sending) composer.pick(entry);
      }}
    />
  ) : composer.skill?.variables.length ? (
    <SkillFields
      skill={composer.skill}
      values={composer.fields}
      onChange={(key, value) => {
        if (!pending.current.sending) composer.setField(key, value);
      }}
      onSubmit={() => void send()}
    />
  ) : null;
  const menuExtra = useMemo(
    () => ({
      items: [
        { id: 'agent', title: tNow('composer.pickAgent'), icon: 'at' as const },
        ...(skills.length ? [{ id: 'skills', title: tNow('composer.skills'), icon: 'wand' as const }] : []),
      ],
      onSelect: (choice: string) => {
        if (pending.current.sending) return;
        if (choice === 'agent') composer.startMention();
        else composer.startSkill();
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the starters are stable callbacks of the composer
    [skills.length, composer.startMention, composer.startSkill],
  );

  const name = me.name || t('conversation.you');
  const lines = starters?.skills.length ? [] : (starters?.lines ?? []).slice(0, 3);
  const skillStartersShown = (starters?.skills ?? []).slice(0, 3);

  return (
    <View style={styles.root}>
      <ConversationHeader
        model={headerModel}
        onDrawer={() => navigation.dispatch(DrawerActions.openDrawer())}
        onTitle={() => undefined}
        onComputer={() => undefined}
        onNotifications={() => router.push('/notifications')}
        onMenu={() => undefined}
      />
      <View
        style={[styles.heroWrap, { top: headerHeight, bottom: composerH + composerBottom }]}
        pointerEvents="box-none"
      >
        <ScrollView
          contentContainerStyle={styles.heroScroll}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentInsetAdjustmentBehavior="never"
        >
          <Animated.View entering={FadeIn.duration(320)} style={[styles.hero, heroLift]}>
            <HeroAvatar agent={answering} size={76} animate={focused} />
            <Text style={styles.heroTitle}>{t('conversation.greeting', { greeting: greeting(), name })}</Text>
            <Text style={styles.heroSub}>
              {answering && !answering.is_main
                ? t('conversation.newChatWithAgent', { name: answering.name })
                : t('conversation.newChatHint')}
            </Text>
            <View style={styles.starters}>
              {skillStartersShown.map((skill) => (
                <Pressable
                  key={skill.id}
                  disabled={sending}
                  onPress={() => {
                    if (!pending.current.sending) composer.chooseSkill(skill);
                  }}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.starter, pressed && styles.pressed]}
                >
                  <Icon name="wand" size={14} color={c.accent} />
                  <Text numberOfLines={1} style={styles.starterText}>
                    /{skill.name}
                    {skill.display_name ? ` · ${skill.display_name}` : ''}
                  </Text>
                </Pressable>
              ))}
              {lines.map((line) => (
                <Pressable
                  key={line}
                  disabled={sending}
                  onPress={() => {
                    if (pending.current.sending) return;
                    composer.setValue(line);
                    composer.focus();
                  }}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.starter, pressed && styles.pressed]}
                >
                  <Text numberOfLines={2} style={styles.starterText}>
                    {line}
                  </Text>
                </Pressable>
              ))}
            </View>
          </Animated.View>
        </ScrollView>
      </View>
      <KeyboardStickyView offset={stickyOffset} style={styles.sticky}>
        <View
          style={[{ paddingBottom: composerBottom }, Platform.OS === 'android' && { backgroundColor: c.background }]}
        >
          <Composer
            ref={composer.inputRef}
            value={composer.value}
            onChangeText={(value) => {
              if (!pending.current.sending) composer.setValue(value);
            }}
            onSend={() => void send()}
            sending={sending}
            locked={sending}
            onAttach={(from) => {
              if (pending.current.sending || attaching.current) return;
              attaching.current = true;
              void composer.attach(from).finally(() => {
                attaching.current = false;
              });
            }}
            quote={composer.quote?.text ?? null}
            onClearQuote={() => {
              if (!pending.current.sending) composer.setQuote(null);
            }}
            files={composer.files}
            onRemoveFile={(id) => {
              if (!pending.current.sending) composer.removeFile(id);
            }}
            onRetryFiles={() => {
              if (!pending.current.sending) composer.retryFiles();
            }}
            skill={
              composer.skill
                ? `/${composer.skill.name}${composer.skill.display_name ? ` · ${composer.skill.display_name}` : ''}`
                : null
            }
            onClearSkill={() => {
              if (!pending.current.sending) composer.clearSkill();
            }}
            placeholder={t('composer.placeholder', { name: answering?.name ?? 'Greeny' })}
            autoFocus={compose}
            onHeight={setComposerH}
            accessory={accessory}
            onSelectionChange={composer.onSelectionChange}
            menuExtra={menuExtra}
          />
        </View>
      </KeyboardStickyView>
    </View>
  );
}

const NO_SKILLS: Skill[] = [];

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.background },
  heroWrap: { position: 'absolute', left: 0, right: 0 },
  heroScroll: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: space.lg },
  hero: { alignItems: 'center', paddingHorizontal: space.xxl, gap: space.xs },
  heroTitle: { ...typo.title2, color: c.label, textAlign: 'center', marginTop: space.md },
  heroSub: { ...typo.body, color: c.secondaryLabel, textAlign: 'center' },
  starters: { alignSelf: 'stretch', gap: space.sm, marginTop: space.lg },
  starter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 44,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.separator,
    ...squircle,
  },
  starterText: { flexShrink: 1, ...typo.subheadline, fontWeight: weight.medium, color: c.label },
  pressed: { backgroundColor: c.fill },
  sticky: { position: 'absolute', left: 0, right: 0, bottom: 0 },
}));
