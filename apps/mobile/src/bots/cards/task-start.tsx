/**
 * A task card's body (in the card's sheet): the task's title, then its whole brief as Markdown.
 * Starting it is the card's decision. A background task (at most three run at once — `limit`
 * refusal) runs read-only and reports back; in `chat` mode (spec 20261011-agent-first-class D25)
 * it opens a new chat the member keeps talking in — said in one quiet line above the title, naming
 * the Agent when another one than the proposer will answer there.
 *
 * The title and brief are keyed on the text size: on iOS (RN 0.86 Fabric) a Dynamic Type
 * change leaves mounted text measured at the old size (facebook/react-native#57512); a fresh
 * mount is measured at the new one.
 */

import React from 'react';
import { Text, useWindowDimensions } from 'react-native';
import type { BotRequestView, BotTaskStartPayload } from '../../shared/bots';
import { Markdown } from '../../chat/markdown';
import { useT } from '../../lib/i18n';
import { typo, useTheme, weight } from '../../theme';
import { useBotName } from './card-frame';
import { chatStart } from './decision';

export function TaskStartBody({ request }: { request: BotRequestView }) {
  const { colors: c } = useTheme();
  const t = useT();
  const payload = request.payload as BotTaskStartPayload;
  const brief = typeof payload.brief === 'string' ? payload.brief.trim() : '';
  const { fontScale } = useWindowDimensions();
  const chat = chatStart(request);
  // Another Agent than the one asking answers there: name it.
  const other = chat?.agent && chat.agent !== request.bot_id ? chat.agent : null;
  const otherName = useBotName(other);
  return (
    <>
      {chat ? (
        <Text key={`chat:${fontScale}`} style={{ ...typo.footnote, color: c.secondaryLabel }}>
          {other ? t('bots.card.chatNoteWith', { name: otherName }) : t('bots.card.chatNote')}
        </Text>
      ) : null}
      {payload.title ? (
        <Text key={`title:${fontScale}`} style={{ ...typo.title3, fontWeight: weight.semibold, color: c.label }} selectable>
          {payload.title}
        </Text>
      ) : null}
      {brief ? <Markdown key={`brief:${fontScale}`} source={brief} /> : null}
    </>
  );
}
