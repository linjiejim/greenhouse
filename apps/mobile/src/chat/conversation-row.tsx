/**
 * One conversation in a list (home's recent five, the all-conversations sheet): the title and the
 * time, then one line of the newest message (where the station sends it); a pin trails pinned ones,
 * and an agent other than Sprouty leads with its plant (src/data/home.ts `conversationAgent`).
 * Swipe left to pin or unpin (Mail-style trailing action; the
 * swipe itself pins); long press offers pin and rename too, and VoiceOver gets both as
 * actions. Tapping opens the conversation page.
 */

import React, { useRef } from 'react';
import { Text } from 'react-native';
import Swipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import { conversationAgent } from '../data/home';
import { useT } from '../lib/i18n';
import { plainText } from '../lib/plain-text';
import { relativeTimeNow } from '../lib/time-words';
import type { ChatSession } from '../shared/greenhouse-types';
import { makeStyles, space, typo, useTheme, weight } from '../theme';
import { AgentAvatar } from '../ui/avatar';
import { Icon, Touchable } from '../ui/core';
import { selectionTick } from '../ui/haptics';
import { Row, type RowPosition } from '../ui/list';
import { NativeMenu } from '../ui/menu';

export function ConversationRow({
  session,
  position,
  onOpen,
  onPin,
  onRename,
}: {
  session: ChatSession;
  position: RowPosition;
  onOpen: () => void;
  onPin: (pinned: boolean) => void;
  onRename: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const swipe = useRef<SwipeableMethods>(null);
  const title = session.title?.trim() || t('assistant.untitled');
  const snippet = plainText(session.last_message, { oneLine: true });
  const agent = conversationAgent(session.profile_id);
  const when = relativeTimeNow(session.updated_at);
  const pin = () => {
    selectionTick();
    swipe.current?.close();
    onPin(!session.pinned);
  };
  const select = (id: string) => (id === 'pin' ? pin() : onRename());
  return (
    <Swipeable
      ref={swipe}
      friction={1.6}
      rightThreshold={56}
      overshootRight={false}
      // swiping past the threshold pins (only the trailing action exists)
      onSwipeableOpen={pin}
      renderRightActions={() => (
        <Touchable onPress={pin} style={styles.action} accessibilityRole="button" accessibilityLabel={t(session.pinned ? 'home.unpin' : 'home.pin')}>
          <Icon name={session.pinned ? 'pinOff' : 'pin'} size={18} color={c.onTint} />
          <Text style={styles.actionText}>{t(session.pinned ? 'home.unpin' : 'home.pin')}</Text>
        </Touchable>
      )}
      containerStyle={styles.swipe}
    >
      <NativeMenu
        trigger="longPress"
        items={[
          { id: 'pin', title: t(session.pinned ? 'home.unpin' : 'home.pin'), icon: session.pinned ? 'pinOff' : 'pin' },
          { id: 'rename', title: t('home.rename'), icon: 'pen' },
        ]}
        onSelect={select}
      >
        <Row
          title={title}
          subtitle={snippet || undefined}
          subtitleLines={1}
          leading={agent ? <AgentAvatar name={agent} size={28} /> : undefined}
          leadingWidth={agent ? 28 : undefined}
          value={when}
          accessory={session.pinned ? <Icon name="pin" size={13} color={c.accent} /> : 'none'}
          position={position}
          onPress={onOpen}
          accessibilityLabel={[session.pinned ? t('home.pinned') : '', title, when, snippet].filter(Boolean).join(t('common.listSep'))}
          accessibilityActions={[
            { name: 'pin', label: t(session.pinned ? 'home.unpin' : 'home.pin') },
            { name: 'rename', label: t('home.rename') },
          ]}
          onAccessibilityAction={(event) => select(event.nativeEvent.actionName)}
        />
      </NativeMenu>
    </Swipeable>
  );
}

const useStyles = makeStyles((c) => ({
  swipe: { overflow: 'visible' },
  action: {
    width: 84,
    marginRight: space.margin,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xxs,
    backgroundColor: c.orange,
  },
  actionText: { ...typo.caption1, fontWeight: weight.semibold, color: c.onTint },
}));
