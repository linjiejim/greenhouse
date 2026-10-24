/**
 * One conversation in a list (home's recent five, the all-conversations sheet): one line — a pin
 * or a bubble, the title, the time. Swipe left to pin or unpin (Mail-style trailing action; the
 * swipe itself pins); long press offers pin and rename too, and VoiceOver gets both as
 * actions. Tapping opens the conversation page.
 */

import React, { useRef } from 'react';
import { Text } from 'react-native';
import Swipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import { useT } from '../lib/i18n';
import { relativeTimeNow } from '../lib/time-words';
import type { ChatSession } from '../shared/greenhouse-types';
import { makeStyles, space, typo, useTheme, weight } from '../theme';
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
          leading={<Icon name={session.pinned ? 'pin' : 'msg'} size={18} color={session.pinned ? c.accent : c.secondaryLabel} />}
          leadingWidth={22}
          value={relativeTimeNow(session.updated_at)}
          position={position}
          onPress={onOpen}
          accessibilityLabel={[session.pinned ? t('home.pinned') : '', title, relativeTimeNow(session.updated_at)].filter(Boolean).join(t('common.listSep'))}
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
