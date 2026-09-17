/**
 * Full Chat page host.
 *
 * Conversation behavior lives in the shared ConversationPane; this route selects
 * the full-page surface and owns the split layout beside it.
 *
 * The split is here rather than inside ConversationPane on purpose: that
 * component is already ~1700 lines carrying two surfaces, and the surfaces spec
 * (20260730 D5) put the layout in the host from the start. The host wrapper
 * owns `flex-1 min-w-0`: ConversationPane is also rendered in
 * the Assistant overlay, where claiming all available width is the host's job.
 */

import React from 'react';
import type { AssistantLaunchRequest } from '@greenhouse/types/agent-context';
import { ConversationPane } from '../components/conversation/conversation-pane';
import { ChatSidePane, useSidePaneHost } from '../components/side-pane/chat-side-pane';

interface ChatPageProps {
  initialSessionId?: string;
  initialProfileId?: string;
  launchRequest?: AssistantLaunchRequest | null;
  onLaunchConsumed?: (id: number) => void;
}

export function ChatPage({ initialSessionId, initialProfileId, launchRequest, onLaunchConsumed }: ChatPageProps) {
  useSidePaneHost(initialSessionId ?? '__new__');

  return (
    <div className="flex h-full min-h-0 w-full">
      <div className="min-w-0 flex-1">
        <ConversationPane
          surface="full"
          initialSessionId={initialSessionId}
          initialProfileId={initialProfileId}
          launchRequest={launchRequest}
          onLaunchConsumed={onLaunchConsumed}
        />
      </div>
      <ChatSidePane />
    </div>
  );
}
