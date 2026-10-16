/**
 * A conversation's native navigation bar (PRD §6.2, conversation.md):
 *
 *   [☰]      (🌱) Greeny ›            [🖥] [🔔³] [⋯]
 *            主线
 *
 *  - Left: ☰ opens the drawer.
 *  - Title view: the answering Agent's plant (a room: its people), the name and one status
 *    line — 「运行中」 while an Agent answers, else 主线 / the Agent's role / 「N 人」. Tap: the
 *    Agent's profile, or a room's people.
 *  - Right: 🖥 the Agent's computer (when this member has computers), 🔔 the notification center
 *    with the one badge (the needs-you count, else a dot for anything unread), and ⋯ with this
 *    conversation's actions — the same as its row's long press in the drawer.
 *
 * Memoised: Stack.Toolbar re-applies the navigation options whenever it re-renders.
 */

import React, { memo } from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Stack } from 'expo-router';
import { useT } from '../lib/i18n';
import type { Badge } from '../data/directory';
import { makeStyles, space, typo, useTheme, weight } from '../theme';
import { AgentAvatar, WorkingAgentAvatar, MemberAvatar, type AgentFace } from '../ui/agent-avatar';
import { Icon } from '../ui/core';
import { useFontScaleKey } from '../ui/font-scale';
import { toolbarIcon } from '../ui/toolbar-icon';

/** Navigation-bar text never grows past this Dynamic Type multiple (the system's large content viewer covers it). */
const MAX_FONT_SCALE = 1.3;
/** Room the bar's own buttons take. */
const BAR_BUTTONS_W = 210;

export type MenuAction =
  | 'pin'
  | 'unpin'
  | 'rename'
  | 'share'
  | 'archive'
  | 'delete'
  | 'mute'
  | 'unmute'
  | 'markRead'
  | 'profile'
  | 'newChat'
  | 'notes'
  | 'people'
  | 'addPeople'
  | 'leave';

export interface HeaderModel {
  title: string;
  status: string;
  /** The answering Agent (null in a room). */
  agent: AgentFace | null;
  avatarReply?: { id: string; content: string; status: string };
  avatarWorking?: boolean;
  avatarWaiting?: boolean;
  /** A room's first people (faces). */
  people?: { name: string; avatarUrl: string | null; agent?: AgentFace }[];
  kind: 'main' | 'direct' | 'chat' | 'room' | 'new';
  pinned: boolean;
  muted: boolean;
  unread: boolean;
  /** The 🖥 button: the Agent has a computer for me. */
  computer: boolean;
  badge: Badge;
}

export const ConversationHeader = memo(function ConversationHeader({
  model,
  onDrawer,
  onTitle,
  onComputer,
  onNotifications,
  onMenu,
}: {
  model: HeaderModel;
  onDrawer: () => void;
  onTitle: () => void;
  onComputer: () => void;
  onNotifications: () => void;
  onMenu: (action: MenuAction) => void;
}) {
  const t = useT();
  const { kind } = model;
  const bellLabel = model.badge ? t('shell.notificationsUnread') : t('shell.notifications');
  const thread = kind === 'main' || kind === 'direct';
  return (
    <>
      <Stack.Screen options={{ title: model.title }} />
      <Stack.Title asChild>
        <TitleView model={model} onPress={onTitle} />
      </Stack.Title>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button
          icon={toolbarIcon('menu')}
          accessibilityLabel={t('shell.openDrawer')}
          onPress={onDrawer}
        />
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        {model.computer ? (
          <Stack.Toolbar.Button
            icon={toolbarIcon('computer')}
            accessibilityLabel={t('computer.open')}
            onPress={onComputer}
          />
        ) : null}
        <Stack.Toolbar.Button
          icon={toolbarIcon(model.badge?.kind === 'dot' ? 'bellBadge' : 'bell')}
          accessibilityLabel={bellLabel}
          onPress={onNotifications}
        />
        {kind === 'new' ? null : (
          <Stack.Toolbar.Menu icon={toolbarIcon('more')} accessibilityLabel={t('common.more')}>
            <Stack.Toolbar.MenuAction icon={toolbarIcon('book')} onPress={() => onMenu('notes')}>
              {t('integration.notes')}
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.Menu inline hidden={!thread && kind !== 'chat'}>
              <Stack.Toolbar.MenuAction icon={toolbarIcon('compose')} onPress={() => onMenu('newChat')}>
                {t('conversation.newChatWith')}
              </Stack.Toolbar.MenuAction>
              <Stack.Toolbar.MenuAction icon={toolbarIcon('person')} onPress={() => onMenu('profile')}>
                {t('conversation.agentProfile')}
              </Stack.Toolbar.MenuAction>
            </Stack.Toolbar.Menu>
            <Stack.Toolbar.Menu inline hidden={kind !== 'room'}>
              <Stack.Toolbar.MenuAction icon={toolbarIcon('users')} onPress={() => onMenu('people')}>
                {t('conversation.people')}
              </Stack.Toolbar.MenuAction>
              <Stack.Toolbar.MenuAction icon={toolbarIcon('userPlus')} onPress={() => onMenu('addPeople')}>
                {t('conversation.addPeople')}
              </Stack.Toolbar.MenuAction>
            </Stack.Toolbar.Menu>
            <Stack.Toolbar.Menu inline>
              <Stack.Toolbar.MenuAction
                icon={toolbarIcon(model.pinned ? 'pinOff' : 'pin')}
                hidden={kind !== 'chat'}
                onPress={() => onMenu(model.pinned ? 'unpin' : 'pin')}
              >
                {model.pinned ? t('row.unpin') : t('row.pin')}
              </Stack.Toolbar.MenuAction>
              <Stack.Toolbar.MenuAction
                icon={toolbarIcon('pen')}
                hidden={kind !== 'chat' && kind !== 'room'}
                onPress={() => onMenu('rename')}
              >
                {t('row.rename')}
              </Stack.Toolbar.MenuAction>
              <Stack.Toolbar.MenuAction
                icon={toolbarIcon(model.muted ? 'bell' : 'bellSlash')}
                hidden={kind === 'chat'}
                onPress={() => onMenu(model.muted ? 'unmute' : 'mute')}
              >
                {model.muted ? t('row.unmute') : t('row.mute')}
              </Stack.Toolbar.MenuAction>
              <Stack.Toolbar.MenuAction
                icon={toolbarIcon('checkCircle')}
                hidden={kind === 'chat' || !model.unread}
                onPress={() => onMenu('markRead')}
              >
                {t('row.markRead')}
              </Stack.Toolbar.MenuAction>
              <Stack.Toolbar.MenuAction icon={toolbarIcon('share')} onPress={() => onMenu('share')}>
                {t('row.export')}
              </Stack.Toolbar.MenuAction>
              <Stack.Toolbar.MenuAction
                icon={toolbarIcon('archive')}
                hidden={kind !== 'chat'}
                onPress={() => onMenu('archive')}
              >
                {t('row.archive')}
              </Stack.Toolbar.MenuAction>
            </Stack.Toolbar.Menu>
            <Stack.Toolbar.Menu inline hidden={kind !== 'chat' && kind !== 'room'}>
              <Stack.Toolbar.MenuAction
                icon={toolbarIcon('trash')}
                destructive
                hidden={kind !== 'chat'}
                onPress={() => onMenu('delete')}
              >
                {t('row.delete')}
              </Stack.Toolbar.MenuAction>
              <Stack.Toolbar.MenuAction
                icon={toolbarIcon('logout')}
                destructive
                hidden={kind !== 'room'}
                onPress={() => onMenu('leave')}
              >
                {t('conversation.leave')}
              </Stack.Toolbar.MenuAction>
            </Stack.Toolbar.Menu>
          </Stack.Toolbar.Menu>
        )}
      </Stack.Toolbar>
    </>
  );
});

/** The title view: a face, the name and one live status line. One VoiceOver button. */
function TitleView({ model, onPress }: { model: HeaderModel; onPress: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const { width } = useWindowDimensions();
  const fontKey = useFontScaleKey();
  const openable = model.kind !== 'new';
  return (
    <Pressable
      onPress={onPress}
      disabled={!openable}
      accessibilityRole="button"
      accessibilityLabel={model.status ? `${model.title}, ${model.status}` : model.title}
      accessibilityHint={
        openable ? t(model.kind === 'room' ? 'conversation.titleHintRoom' : 'conversation.titleHint') : undefined
      }
      style={({ pressed }) => [styles.title, { maxWidth: width - BAR_BUTTONS_W }, pressed && styles.pressed]}
    >
      {model.kind === 'room' ? (
        (model.people?.length ?? 0) > 1 ? (
          <View style={styles.people}>
            {model.people!.slice(0, 2).map((person, index) => (
              <View key={`${person.name}-${index}`} style={index ? styles.overlap : null}>
                {person.agent ? (
                  <AgentAvatar agent={person.agent} size={22} />
                ) : (
                  <MemberAvatar name={person.name} url={person.avatarUrl} size={22} />
                )}
              </View>
            ))}
          </View>
        ) : (
          <Icon name="users" size={18} color={c.secondaryLabel} />
        )
      ) : (
        <WorkingAgentAvatar
          agent={model.agent}
          size={26}
          working={model.avatarWorking}
          waiting={model.avatarWaiting}
          reply={model.avatarReply}
        />
      )}
      <View key={fontKey} style={styles.texts}>
        <View style={styles.nameRow}>
          <Text numberOfLines={1} maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.name}>
            {model.title}
          </Text>
          {openable ? <Icon name="chevR" size={9} weight="bold" color={c.tertiaryLabel} /> : null}
        </View>
        {model.status ? (
          <Animated.Text
            key={model.status}
            entering={FadeIn.duration(180)}
            numberOfLines={1}
            maxFontSizeMultiplier={MAX_FONT_SCALE}
            style={styles.status}
          >
            {model.status}
          </Animated.Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const useStyles = makeStyles((c) => ({
  title: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  pressed: { opacity: 0.55 },
  people: { flexDirection: 'row' },
  overlap: { marginLeft: -8 },
  texts: { flexShrink: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  name: { flexShrink: 1, ...typo.headline, fontWeight: weight.semibold, color: c.label },
  status: { ...typo.caption1, color: c.secondaryLabel },
}));
