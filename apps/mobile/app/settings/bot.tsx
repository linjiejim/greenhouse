/**
 * Settings → My Bots → a Bot (`/settings/bot?id=`, pushed in the settings
 * stack): the full-page Bot profile — the same `BotProfileView` as the
 * `/bots/profile` sheet (spec docs/specs/20261008-mobile-bots.md §2.5.7), the
 * name as the inline bar title. 发消息 / 新对话 close the whole Settings modal
 * on their way home; 编辑 opens the Bot form sheet over this page.
 */

import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { BotProfileView } from '../../src/bots/manage/bot-profile-view';

export default function SettingsBot() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <BotProfileView botId={id ?? ''} presentation="page" />;
}
