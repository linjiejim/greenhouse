/** A notification as an object sheet (`/sheet/notification?id=`); the view is src/notifications/notification-view.tsx. */

import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { NotificationView } from '../../src/notifications/notification-view';

export default function NotificationPage() {
  const { id: raw } = useLocalSearchParams<{ id?: string }>();
  return <NotificationView id={typeof raw === 'string' ? raw : ''} />;
}
