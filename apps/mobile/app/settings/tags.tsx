/**
 * Settings → 标签 (pushed page in the settings stack): the user's tag library
 * in manage mode — tap to edit, swipe / touch-and-hold for edit & delete,
 * 新建标签 opens the editor sheet.
 */

import React from 'react';
import { Stack } from 'expo-router';
import { TagLibrary } from '../../src/chat/tag-library';
import { useT } from '../../src/lib/i18n';

export default function SettingsTags() {
  const t = useT();
  return (
    <>
      <Stack.Screen options={{ title: t('tags.title') }} />
      <TagLibrary />
    </>
  );
}
