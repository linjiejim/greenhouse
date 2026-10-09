import { brandFont as font } from '../../ui/brand-font';
/**
 * One member in the conversation-info sheet's SwiftUI Form (app/bots/info.tsx;
 * spec docs/specs/20261008-mobile-bots.md §2.5.7): the plant (a small RN
 * island — at most six per sheet), name, role line and the member's badge
 * (主人 / 主理 / 成员 / 客串 / 已归档, the list row's native `.badge`).
 * Tapping opens the Bot's profile; a removable member also gets 移出 as a
 * trailing swipe action and in its touch-and-hold menu (the caller confirms).
 */

import React from 'react';
import { View } from 'react-native';
import { Button, ContextMenu, HStack, RNHostView, SwipeActions, Text, VStack } from '@expo/ui/swift-ui';
import { accessibilityLabel, badge, foregroundStyle, lineLimit, tint } from '@expo/ui/swift-ui/modifiers';
import { useT } from '../../lib/i18n';
import type { BotView } from '../../shared/bots';
import { useTheme } from '../../theme';
import { BotAvatar } from '../ui/bot-avatar';
import type { MemberLabel } from './member-model';

const PRIMARY = foregroundStyle({ type: 'hierarchical', style: 'primary' });
const SECONDARY = foregroundStyle({ type: 'hierarchical', style: 'secondary' });
const AVATAR = 30;

export function MemberRow({
  bot,
  label,
  removable,
  onPress,
  onRemove,
}: {
  /** null: the directory has not answered for this id yet (a placeholder disc, never "Deleted Bot"). */
  bot: BotView | null;
  label: MemberLabel;
  removable: boolean;
  onPress: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const { hex } = useTheme();
  const name = bot?.name ?? '';
  const role = t(`bots.manage.memberRole.${label}`);
  const row = (
    <Button
      onPress={onPress}
      modifiers={[PRIMARY, badge(role), accessibilityLabel([name, bot?.role, role].filter(Boolean).join(', '))]}
    >
      <HStack spacing={12}>
        <RNHostView matchContents>
          <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <BotAvatar bot={bot} size={AVATAR} state={label === 'archived' ? 'sleep' : undefined} animate={false} />
          </View>
        </RNHostView>
        <VStack alignment="leading" spacing={1}>
          <Text modifiers={[lineLimit(1)]}>{name}</Text>
          {bot?.role ? (
            <Text modifiers={[font({ textStyle: 'footnote' }), SECONDARY, lineLimit(1)]}>{bot.role}</Text>
          ) : null}
        </VStack>
      </HStack>
    </Button>
  );
  if (!removable) return row;
  return (
    <SwipeActions>
      <ContextMenu>
        <ContextMenu.Trigger>{row}</ContextMenu.Trigger>
        <ContextMenu.Items>
          <Button
            role="destructive"
            systemImage="person.badge.minus"
            label={t('bots.manage.remove')}
            onPress={onRemove}
          />
        </ContextMenu.Items>
      </ContextMenu>
      {/* not role="destructive": that animates the row away before the confirm alert */}
      <SwipeActions.Actions edge="trailing" allowsFullSwipe={false}>
        <Button
          systemImage="person.badge.minus"
          label={t('bots.manage.remove')}
          onPress={onRemove}
          modifiers={[tint(hex.red)]}
        />
      </SwipeActions.Actions>
    </SwipeActions>
  );
}
