/**
 * ⋯ → 显示 › 思考过程 / 工具调用 / 引用来源 — the reply details a member can
 * switch on, in every conversation's overflow menu (the chat's and a Bots
 * thread's). Global and remembered (src/store/prefs.ts `details`); all off by
 * default, so a reply reads as its answer alone (src/chat/message.tsx).
 *
 * A function, not a component: `Stack.Toolbar.Menu` reads its children by
 * element type, so the submenu has to be placed inline in the bar's JSX.
 */

import React from 'react';
import { Stack } from 'expo-router';
import type { TFunction } from '../lib/i18n';
import type { ReplyDetail, ReplyDetails } from '../store/prefs';
import { toolbarIcon } from '../ui/toolbar-icon';

export function replyDetailsMenu(
  t: TFunction,
  details: ReplyDetails,
  setDetail: (detail: ReplyDetail, on: boolean) => void,
): React.ReactElement {
  return (
    <Stack.Toolbar.Menu title={t('chat.show')} icon={toolbarIcon('eye')}>
      <Stack.Toolbar.MenuAction
        icon={toolbarIcon('brain')}
        isOn={details.reasoning}
        onPress={() => setDetail('reasoning', !details.reasoning)}
      >
        {t('chat.reasoning')}
      </Stack.Toolbar.MenuAction>
      <Stack.Toolbar.MenuAction
        icon={toolbarIcon('wrench')}
        isOn={details.tools}
        onPress={() => setDetail('tools', !details.tools)}
      >
        {t('chat.toolCalls')}
      </Stack.Toolbar.MenuAction>
      <Stack.Toolbar.MenuAction
        icon={toolbarIcon('book')}
        isOn={details.sources}
        onPress={() => setDetail('sources', !details.sources)}
      >
        {t('chat.showSources')}
      </Stack.Toolbar.MenuAction>
    </Stack.Toolbar.Menu>
  );
}
