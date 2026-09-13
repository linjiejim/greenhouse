import { Bot, MessageSquare, Zap, type LucideIcon } from '../../lib/icons';
import type { TranslationKey } from '../../lib/i18n';
import type { ChatWorkspaceView } from '../../stores';

export interface ChatWorkspaceNavigationItem {
  id: Exclude<ChatWorkspaceView, 'conversation'>;
  labelKey: TranslationKey;
  icon: LucideIcon;
}

export const CHAT_WORKSPACE_ITEMS: readonly ChatWorkspaceNavigationItem[] = [
  {
    id: 'prompts',
    labelKey: 'navigation.myPrompts',
    icon: MessageSquare,
  },
  {
    id: 'automations',
    labelKey: 'navigation.automation',
    icon: Zap,
  },
  {
    id: 'agents',
    labelKey: 'navigation.myAgents',
    icon: Bot,
  },
] as const;

export function chatWorkspaceLabel(view: ChatWorkspaceView, t: (key: TranslationKey) => string): string | null {
  if (view === 'conversation') return null;
  const item = CHAT_WORKSPACE_ITEMS.find((candidate) => candidate.id === view);
  return item ? t(item.labelKey) : null;
}
