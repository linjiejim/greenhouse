/**
 * Message list — user bubbles are local; assistant rendering reuses the shared
 * kit (RichMarkdown + ToolCallRenderer + BodyArtifacts + ReasoningPanel), and
 * the in-flight turn is the same StreamingMessageBubble the web app uses.
 */

import React, { useEffect, useRef, useState } from 'react';
import { RichMarkdown } from '@greenhouse/ui/components/rich-markdown';
import { ToolCallRenderer } from '@greenhouse/ui/components/tool-call';
import { BodyArtifacts, partitionCalls } from '@greenhouse/ui/components/tool-call/body-artifacts';
import { ReasoningPanel } from '@greenhouse/ui/components/chat/reasoning-panel';
import { StreamingMessageBubble } from '@greenhouse/ui/components/chat/streaming-message-bubble';
import { ChevronDown, ChevronRight } from '@greenhouse/ui/lib/icons';
import { useT } from '@greenhouse/ui/lib/i18n';
import type { ChatMessage, StreamingState } from './use-chat';

interface MessagesProps {
  messages: ChatMessage[];
  streaming: StreamingState | null;
  onAskUserSubmit: (message: string) => void;
}

export function Messages({ messages, streaming, onAskUserSubmit }: MessagesProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, streaming?.text, streaming?.toolCalls.length]);

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
      {messages.map((m, i) =>
        m.role === 'user' ? (
          <UserBubble key={i} content={m.content} />
        ) : (
          <AssistantMessage
            key={i}
            message={m}
            onAskUserSubmit={onAskUserSubmit}
            hasFollowUp={messages.slice(i + 1).some((n) => n.role === 'user')}
          />
        ),
      )}
      {streaming && (
        <StreamingMessageBubble
          text={streaming.text}
          reasoning={streaming.reasoning}
          toolCalls={streaming.toolCalls}
          isStreaming
        />
      )}
      <div ref={bottomRef} />
    </div>
  );
}

function UserBubble({ content }: { content: string }) {
  return (
    <div className="ml-8 self-end rounded-2xl rounded-br-md bg-primary-600 px-3 py-2 text-sm text-white">
      <p className="whitespace-pre-wrap break-words">{content}</p>
    </div>
  );
}

function AssistantMessage({
  message,
  onAskUserSubmit,
  hasFollowUp,
}: {
  message: ChatMessage;
  onAskUserSubmit: (m: string) => void;
  hasFollowUp: boolean;
}) {
  const t = useT();
  const [showReasoning, setShowReasoning] = useState(false);
  const { trace, artifacts } = partitionCalls(message.toolCalls);

  return (
    <div className="max-w-full self-start text-sm">
      {message.reasoning && (
        <button
          className="mb-1 flex items-center gap-1 text-xs text-fg-faint hover:text-fg-muted"
          onClick={() => setShowReasoning((v) => !v)}
        >
          {showReasoning ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {t('panel.reasoning')}
        </button>
      )}
      {showReasoning && message.reasoning && <ReasoningPanel reasoning={message.reasoning} />}
      {trace.length > 0 && <ToolCallRenderer calls={trace} variant="compact" defaultCollapsed />}
      {artifacts.length > 0 && (
        <BodyArtifacts
          calls={artifacts}
          ctx={{ onAskUserSubmit, askUserSubmitted: hasFollowUp, streaming: false, content: message.content }}
        />
      )}
      {message.content && <RichMarkdown compact content={message.content} />}
    </div>
  );
}
