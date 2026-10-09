/**
 * A background-task card's body (in the card's sheet): the task's title, then
 * its whole brief as Markdown. Starting it is the card's decision; at most
 * three tasks run at once (`limit` refusal).
 *
 * The title and brief are keyed on the text size: on iOS (RN 0.86 Fabric) a Dynamic Type
 * change leaves mounted text measured at the old size (facebook/react-native#57512); a fresh
 * mount is measured at the new one.
 */

import React from 'react';
import { Text, useWindowDimensions } from 'react-native';
import type { BotRequestView, BotTaskStartPayload } from '../../shared/bots';
import { Markdown } from '../../chat/markdown';
import { typo, useTheme, weight } from '../../theme';

export function TaskStartBody({ request }: { request: BotRequestView }) {
  const { colors: c } = useTheme();
  const payload = request.payload as BotTaskStartPayload;
  const brief = typeof payload.brief === 'string' ? payload.brief.trim() : '';
  const { fontScale } = useWindowDimensions();
  return (
    <>
      {payload.title ? (
        <Text key={`title:${fontScale}`} style={{ ...typo.title3, fontWeight: weight.semibold, color: c.label }} selectable>
          {payload.title}
        </Text>
      ) : null}
      {brief ? <Markdown key={`brief:${fontScale}`} source={brief} /> : null}
    </>
  );
}
