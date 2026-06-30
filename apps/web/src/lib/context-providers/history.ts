import type { ContextProviderDescriptor } from '@greenhouse/types/agent-context';
import { Search, BarChart3 } from '../icons';
import { registerContextProvider } from '../context-registry';

const provider: ContextProviderDescriptor<'history'> = {
  type: 'history',

  label: () => 'Session history',

  emptyMessage: () => 'Ask me to find or analyze past sessions',

  placeholder: () => 'Search or analyze past sessions...',

  quickActions: () => [
    { icon: Search, label: 'Search sessions', msg: 'Search past sessions for: ' },
    { icon: BarChart3, label: 'Session stats', msg: 'Give me a summary of recent session activity and trends.' },
  ],

  contextHint: () =>
    'Current Context: Session History. The user is browsing past conversations. You can help find, analyze, or evaluate past sessions.',
};

registerContextProvider(provider);
export default provider;
