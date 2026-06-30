import type { ContextProviderDescriptor } from '@greenhouse/types/agent-context';
import { Search, BarChart3 } from '../icons';
import { registerContextProvider } from '../context-registry';

const provider: ContextProviderDescriptor<'chat'> = {
  type: 'chat',

  label: (ctx) => `Chat session: ${ctx.sessionId?.slice(0, 8) || ''}`,

  emptyMessage: () => 'Ask me about this chat session',

  placeholder: () => 'Ask about this session...',

  quickActions: () => [
    {
      icon: Search,
      label: 'Check response sources',
      msg: 'Are the references used in the last response accurate and relevant?',
    },
    {
      icon: BarChart3,
      label: 'Summarize this session',
      msg: 'Give me an overview of what was discussed in this session.',
    },
  ],

  contextHint: (ctx) =>
    `Current Context: Chat Session. Session ID: ${ctx.sessionId || '(unknown)'}.` +
    (ctx.lastAssistantMessageId ? ` Last assistant message ID: ${ctx.lastAssistantMessageId}.` : ''),
};

registerContextProvider(provider);
export default provider;
