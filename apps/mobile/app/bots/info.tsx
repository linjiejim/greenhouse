/**
 * `/bots/info?c=` — everything about a conversation that is not the talk
 * itself (spec docs/specs/20261008-mobile-bots.md §2.5.7). A SwiftUI Form,
 * every change applied at once (✕ only); Android: ./info.android.tsx.
 * Behaviour: src/bots/manage/use-conversation-info.ts.
 *
 *  - 它记得的近况: the rolling summary the Bots carry, verbatim (six lines,
 *    显示全部), with when it was last updated — only once there is one;
 *  - a group's settings: name (system prompt), rules (→ /bots/rules), lead
 *    (menu of its active members), "let Bots ask each other";
 *  - members: plant, name, role and badge; tap → the Bot's profile; a group
 *    member (not the lead, while more than two remain) or a DM's guest can be
 *    removed — swipe or touch and hold, confirmed; 邀请 Bot… → /bots/invite
 *    (off at six members);
 *  - shared notes, read-only (open first, pinned first) — they are edited on
 *    the web.
 *
 * The sheet re-reads when it comes back into view (the rules sheet or a
 * profile was on top) and on the server's `bots:conversation` push.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Button, HStack, Image, Picker, Section, Spacer, Text, Toggle, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityElement,
  accessibilityHidden,
  accessibilityLabel,
  disabled,
  font,
  foregroundStyle,
  lineLimit,
  pickerStyle,
  tag,
} from '@expo/ui/swift-ui/modifiers';
import { useT } from '../../src/lib/i18n';
import { relativeTime } from '../../src/lib/format';
import type { BotConversationDetail, BotSharedNoteView } from '../../src/shared/bots';
import {
  GROUP_TITLE_MAX,
  canInviteMore,
  leadChoices,
  memberLabel,
  memberRemovable,
  orderedNotes,
  sortedMembers,
} from '../../src/bots/manage/group-model';
import { MemberRow } from '../../src/bots/manage/member-row';
import { useConversationInfo } from '../../src/bots/manage/use-conversation-info';
import { useBots } from '../../src/bots/store';
import { promptText } from '../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { FormNavRow, NativeForm } from '../../src/ui/native-form';
import { useTheme } from '../../src/theme';
import { SheetClose } from '../../src/ui/sheet-chrome';

const SECONDARY = foregroundStyle({ type: 'hierarchical', style: 'secondary' });
const TERTIARY = foregroundStyle({ type: 'hierarchical', style: 'tertiary' });
/** A summary longer than this reads as more than six lines and folds. */
const FOLD_LINES = 6;
const FOLD_CHARS = 280;

export default function ConversationInfoSheet() {
  const t = useT();
  const { c = '' } = useLocalSearchParams<{ c?: string }>();
  const info = useConversationInfo(c);

  // Back in view after a sheet on top closed (rules, a profile, invite): re-read
  // — without the WS push nothing else would tell this sheet what changed.
  const shown = useRef(false);
  const { reload } = info;
  useFocusEffect(
    useCallback(() => {
      if (shown.current) void reload();
      shown.current = true;
    }, [reload]),
  );

  if (!info.detail) {
    return (
      <>
        <Stack.Screen options={{ title: t('bots.manage.infoTitle') }} />
        <SheetClose />
        <View style={{ flex: 1, justifyContent: 'center' }}>
          {info.load === 'loading' ? (
            <LoadingState />
          ) : info.load === 'not_found' || info.load === 'forbidden' ? (
            <EmptyState icon="msgs" title={t('bots.manage.conversationMissing')} />
          ) : (
            <EmptyState icon="alert" title={t('bots.manage.loadFailed')} onRetry={() => void reload()} />
          )}
        </View>
      </>
    );
  }
  return <InfoForm detail={info.detail} info={info} />;
}

function InfoForm({ detail, info }: { detail: BotConversationDetail; info: ReturnType<typeof useConversationInfo> }) {
  const t = useT();
  const router = useRouter();
  const byId = useBots((s) => s.byId);
  const [expanded, setExpanded] = useState(false);
  const c = detail.session_id;
  const group = detail.kind === 'group';
  const members = useMemo(() => sortedMembers(detail.members), [detail.members]);
  const leads = useMemo(() => leadChoices(detail, byId), [detail, byId]);
  const leadKnown = leads.some((bot) => bot.id === detail.lead_bot_id);
  const roomForMore = canInviteMore(detail);

  const digest = detail.digest?.text.trim() ?? '';
  const folds = digest.split('\n').length > FOLD_LINES || digest.length > FOLD_CHARS;
  const rulesLine = detail.description.trim().split('\n')[0] ?? '';
  const notes = useMemo(() => orderedNotes(detail.notes), [detail.notes]);

  const rename = async () => {
    const title = await promptText({
      title: t('bots.manage.groupName'),
      defaultValue: detail.title ?? '',
      placeholder: t('bots.manage.groupNamePlaceholder'),
    });
    if (title !== null) await info.rename(title.slice(0, GROUP_TITLE_MAX));
  };

  const membersFooter = !roomForMore ? t('bots.manage.max6') : group ? undefined : t('bots.manage.guestFooter');

  return (
    <>
      <Stack.Screen options={{ title: t('bots.manage.infoTitle') }} />
      <SheetClose />
      <NativeForm>
        {digest ? (
          <Section
            title={t('bots.manage.digest')}
            footer={
              detail.digest?.updated_at ? (
                <Text>{t('bots.manage.digestUpdated', { time: relativeTime(detail.digest.updated_at) })}</Text>
              ) : undefined
            }
          >
            <Text modifiers={folds && !expanded ? [lineLimit(FOLD_LINES)] : []}>{digest}</Text>
            {folds ? (
              <Button
                label={expanded ? t('bots.manage.showLess') : t('bots.manage.showAll')}
                onPress={() => setExpanded((v) => !v)}
              />
            ) : null}
          </Section>
        ) : null}

        {group ? (
          <Section footer={<Text>{t('bots.manage.leadFooter')}</Text>}>
            <FormNavRow label={t('bots.manage.groupName')} value={detail.title ?? ''} onPress={() => void rename()} />
            <FormNavRow
              label={t('bots.manage.rules')}
              value={rulesLine || t('bots.manage.rulesNone')}
              onPress={() => router.push({ pathname: '/bots/rules', params: { c } })}
            />
            <Picker
              label={t('bots.manage.lead')}
              selection={leadKnown ? (detail.lead_bot_id ?? '') : ''}
              onSelectionChange={(id) => {
                if (id) void info.setLead(String(id));
              }}
              modifiers={[pickerStyle('menu')]}
            >
              {/* No active lead (it was archived): say so, rather than showing the first member as if it led. */}
              {leadKnown ? null : <Text modifiers={[tag(''), SECONDARY]}>{t('bots.manage.noLead')}</Text>}
              {leads.map((bot) => (
                <Text key={bot.id} modifiers={[tag(bot.id)]}>
                  {bot.name}
                </Text>
              ))}
            </Picker>
          </Section>
        ) : null}

        {group ? (
          <Section footer={<Text>{t('bots.manage.allowBotChatFooter')}</Text>}>
            <Toggle
              label={t('bots.manage.allowBotChat')}
              isOn={detail.allow_bot_chat}
              onIsOnChange={(on) => void info.setAllowBotChat(on)}
            />
          </Section>
        ) : null}

        <Section title={t('bots.manage.members')} footer={membersFooter ? <Text>{membersFooter}</Text> : undefined}>
          {members.map((member) => {
            const bot = byId[member.bot_id] ?? null;
            return (
              <MemberRow
                key={member.bot_id}
                bot={bot}
                label={memberLabel(member, bot)}
                removable={memberRemovable(detail, member)}
                onPress={() => router.push({ pathname: '/bots/profile', params: { botId: member.bot_id, from: c } })}
                onRemove={() => void info.remove(member.bot_id)}
              />
            );
          })}
          <Button
            label={t('bots.manage.inviteRow')}
            systemImage="person.badge.plus"
            onPress={() => router.push({ pathname: '/bots/invite', params: { c } })}
            modifiers={[disabled(!roomForMore)]}
          />
        </Section>

        {notes.length > 0 ? (
          <Section title={t('bots.manage.notes')} footer={<Text>{t('bots.manage.notesFooter')}</Text>}>
            {notes.map((note) => (
              <NoteRow key={note.id} note={note} />
            ))}
          </Section>
        ) : null}
      </NativeForm>
    </>
  );
}

/** A shared note, read-only (Reminders-like: a ring, or a filled check when done; a pin when pinned). */
function NoteRow({ note }: { note: BotSharedNoteView }) {
  const t = useT();
  const { hex } = useTheme();
  const done = note.status === 'done';
  const body = note.body.trim();
  return (
    <HStack
      spacing={10}
      modifiers={[
        accessibilityElement('combine'),
        // the ring / check and the pin are hidden glyphs: their state is in the label
        accessibilityLabel(
          [note.title, body, done ? t('bots.manage.noteDoneA11y') : null, note.pinned ? t('bots.nav.pinnedA11y') : null]
            .filter(Boolean)
            .join(', '),
        ),
      ]}
    >
      <Image
        systemName={done ? 'checkmark.circle.fill' : 'circle'}
        modifiers={[done ? foregroundStyle(hex.accent) : TERTIARY, accessibilityHidden(true)]}
      />
      <VStack alignment="leading" spacing={2}>
        <Text modifiers={done ? [lineLimit(2), SECONDARY] : [lineLimit(2)]}>{note.title}</Text>
        {body ? <Text modifiers={[font({ textStyle: 'footnote' }), SECONDARY, lineLimit(2)]}>{body}</Text> : null}
      </VStack>
      <Spacer />
      {note.pinned ? (
        <Image
          systemName="pin.fill"
          modifiers={[font({ textStyle: 'footnote' }), TERTIARY, accessibilityHidden(true)]}
        />
      ) : null}
    </HStack>
  );
}
