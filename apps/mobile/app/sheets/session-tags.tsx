/**
 * Session tags sheet — `/sheets/session-tags?sessionId=` attaches / detaches
 * tags on one conversation (opened from the conversation's menu and the
 * drawer's row menu); without `sessionId` it is the plain tag library. The
 * body is TagLibrary; changes apply immediately and land in
 * `useTags().sessionTags`, which the conversation renders its chips from —
 * so the toolbar only has ✕ (`SheetClose`), no commit button.
 */

import React from 'react';
import { Stack, useLocalSearchParams } from 'expo-router';
import { TagLibrary } from '../../src/chat/tag-library';
import { useT } from '../../src/lib/i18n';
import { SheetClose } from '../../src/ui/sheet-chrome';

export default function SessionTagsSheet() {
  const t = useT();
  const { sessionId } = useLocalSearchParams<{ sessionId?: string }>();
  return (
    <>
      <Stack.Screen options={{ title: sessionId ? t('tags.sessionTags') : t('tags.title') }} />
      <SheetClose />
      <TagLibrary sessionId={sessionId || undefined} />
    </>
  );
}
