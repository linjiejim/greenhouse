/**
 * The thread's footer row: a run that ended in an error — "This reply was
 * interrupted", with opt-in native Details, dismissible (nothing retries by itself).
 *
 * Nothing while a run is busy: the title's status line already says it
 * ("Working…", "Thinking…" — D14's static line), so the transcript stays
 * quiet until a Bot has something to show.
 */

import React, { memo } from 'react';
import { View } from 'react-native';
import { ReplyError } from '../../../chat/message';
import { space } from '../../../theme';

const wrap = { paddingHorizontal: space.margin, paddingBottom: space.md };

export const RunTail = memo(function RunTail({
  runError,
  onDismissError,
}: {
  runError: string | null;
  onDismissError: () => void;
}) {
  if (!runError) return null;
  return (
    <View style={wrap}>
      <ReplyError error={runError} onDismiss={onDismissError} />
    </View>
  );
});
