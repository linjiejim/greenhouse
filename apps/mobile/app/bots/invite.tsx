/**
 * `/bots/invite?c=` — bring one of your Bots into this conversation (spec
 * docs/specs/20261008-mobile-bots.md §2.5.7). An RN list of the active Bots
 * not here yet (plant, name, role); a tap adds it (`POST …/members`; already
 * a member counts as done), toasts and closes. In a DM the invitee is a guest
 * — it only speaks when @-mentioned (the footer says so). At six members the
 * list is disabled and says why. The last row, 新建一个 Bot…, opens the Bot
 * form, which joins the new Bot here and opens this conversation.
 * Behaviour: src/bots/manage/use-conversation-info.ts (`invite`).
 */

import React, { useMemo, useState } from 'react';
import { ScrollView } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useT } from '../../src/lib/i18n';
import { canInviteMore, inviteCandidates } from '../../src/bots/manage/member-model';
import { useConversationInfo } from '../../src/bots/manage/use-conversation-info';
import { BotsRouteGate } from '../../src/bots/route-gate';
import { useBots } from '../../src/bots/store';
import { BotAvatar } from '../../src/bots/ui/bot-avatar';
import { space, useTheme } from '../../src/theme';
import { Icon, Spinner } from '../../src/ui/core';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { ListRow, ListSection } from '../../src/ui/list';
import { SheetClose } from '../../src/ui/sheet-chrome';

const AVATAR = 32;
/** Empty / failed states sit in the middle of the sheet. */
const CENTERED = { flexGrow: 1, justifyContent: 'center' } as const;

/** Closed Bots (Android, switched off, refused) → home: src/bots/route-gate.tsx. */
export default function InviteRoute() {
  return (
    <BotsRouteGate kind="threads">
      <InviteSheet />
    </BotsRouteGate>
  );
}

function InviteSheet() {
  const t = useT();
  const router = useRouter();
  const { colors: c } = useTheme();
  const { c: sessionId = '' } = useLocalSearchParams<{ c?: string }>();
  const info = useConversationInfo(sessionId);
  const bots = useBots((s) => s.bots);
  const [adding, setAdding] = useState<string | null>(null);

  const { detail } = info;
  const candidates = useMemo(() => (detail ? inviteCandidates(bots, detail) : []), [bots, detail]);
  const roomForMore = detail ? canInviteMore(detail) : false;
  const footer = !roomForMore
    ? t('bots.manage.max6')
    : detail?.kind === 'direct'
      ? t('bots.manage.guestFooter')
      : undefined;

  const add = async (botId: string) => {
    if (adding) return;
    setAdding(botId);
    const ok = await info.invite(botId);
    setAdding(null);
    if (ok) router.back();
  };

  const newBot = () => router.push({ pathname: '/bots/bot-form', params: { inviteTo: sessionId } });

  return (
    <>
      <Stack.Screen options={{ title: t('bots.manage.inviteTitle') }} />
      <SheetClose />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[{ paddingTop: space.sm, paddingBottom: space.xxxl }, !detail && CENTERED]}
      >
        {!detail ? (
          info.load === 'loading' ? (
            <LoadingState />
          ) : info.load === 'not_found' || info.load === 'forbidden' ? (
            <EmptyState icon="msgs" title={t('bots.manage.conversationMissing')} />
          ) : (
            <EmptyState icon="alert" title={t('bots.manage.loadFailed')} onRetry={() => void info.reload()} />
          )
        ) : (
          <ListSection footer={footer}>
            {[
              ...candidates.map((bot) => (
                <ListRow
                  key={bot.id}
                  title={bot.name}
                  subtitle={bot.role || undefined}
                  subtitleLines={1}
                  leading={<BotAvatar bot={bot} size={AVATAR} animate={false} />}
                  leadingWidth={AVATAR}
                  accessory={
                    adding === bot.id ? (
                      <Spinner />
                    ) : (
                      <Icon name="plusCircle" size={22} color={roomForMore ? c.accent : c.tertiaryLabel} />
                    )
                  }
                  disabled={!roomForMore || (adding !== null && adding !== bot.id)}
                  onPress={() => void add(bot.id)}
                  accessibilityLabel={[bot.name, bot.role].filter(Boolean).join(', ')}
                />
              )),
              candidates.length === 0 && roomForMore ? (
                <ListRow key="none" title={t('bots.manage.noOneToInvite')} />
              ) : null,
              <ListRow
                key="new"
                title={t('bots.manage.newBotRow')}
                icon="plus"
                disabled={!roomForMore}
                onPress={newBot}
              />,
            ]}
          </ListSection>
        )}
      </ScrollView>
    </>
  );
}
