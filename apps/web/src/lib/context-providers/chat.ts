import type { ContextProviderDescriptor } from '@greenhouse/types/agent-context';
import { Search, FileText, MessageSquare } from '../icons';
import { registerContextProvider } from '../context-registry';

const provider: ContextProviderDescriptor<'chat'> = {
  type: 'chat',

  label: (ctx) => (ctx.sessionId ? `Chat session: ${ctx.sessionId.slice(0, 8)}` : 'New Chat'),

  emptyMessage: () => 'Ask me to continue, summarize, or check the current conversation',

  quickActions: (_ctx) => {
    return [
      {
        icon: Search,
        label: 'Check sources and assumptions',
        msg: 'Check the latest response’s sources and assumptions, and point out anything uncertain.',
      },
      {
        icon: FileText,
        label: 'Summarize this conversation',
        msg: 'Summarize the current conversation, including decisions, open questions, and next steps.',
      },
      {
        icon: MessageSquare,
        label: 'Continue the discussion',
        msg: 'Continue from the current conversation and help me decide the next step.',
      },
    ];
  },

  contextHint: (ctx) =>
    (ctx.sessionId
      ? `Current Context: Chat Session. Session ID: ${ctx.sessionId}.`
      : 'Current Context: New Chat. The visible conversation has not been saved yet.') +
    (ctx.lastAssistantMessageId ? ` Last assistant message ID: ${ctx.lastAssistantMessageId}.` : '') +
    ' The visible page is this conversation.',
};

registerContextProvider(provider);
export default provider;
