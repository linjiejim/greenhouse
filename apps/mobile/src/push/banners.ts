/** A conversation on screen: its banners in Notification Center go (they are read). */

import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { useStations } from '../store/stations';
import { forConversation, type Presented } from './model';

export async function clearConversationBanners(conversationId: string): Promise<void> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;
  try {
    const list = await Notifications.getPresentedNotificationsAsync();
    const shown: Presented[] = list.map((item) => ({ id: item.request.identifier, data: item.request.content.data }));
    const ids = forConversation(shown, useStations.getState().activeId, conversationId);
    await Promise.all(ids.map((id) => Notifications.dismissNotificationAsync(id)));
  } catch {
    // cosmetic
  }
}
