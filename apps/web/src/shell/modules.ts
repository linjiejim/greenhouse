import { Activity, Bell, MessageSquare, Settings, Shield, Sparkles, type LucideIcon } from 'lucide-react';
import type { MessageKey } from '../i18n/zh';
import type { Route } from '../lib/router';

/** The modules this build has. Knowledge, tables, apps and skills join in M2. */
export type ModuleId = 'chat' | 'agents' | 'runs' | 'notifications' | 'settings' | 'admin';

export const MODULES: Record<ModuleId, { label: MessageKey; icon: LucideIcon }> = {
  chat: { label: 'nav.chat', icon: MessageSquare },
  agents: { label: 'nav.agents', icon: Sparkles },
  runs: { label: 'nav.runs', icon: Activity },
  notifications: { label: 'nav.notifications', icon: Bell },
  settings: { label: 'nav.settings', icon: Settings },
  admin: { label: 'nav.admin', icon: Shield },
};

export function moduleOf(route: Route): ModuleId {
  switch (route.page) {
    case 'agents':
    case 'agent':
      return 'agents';
    case 'runs':
    case 'run':
      return 'runs';
    case 'notifications':
      return 'notifications';
    case 'settings':
      return 'settings';
    case 'admin':
      return 'admin';
    default:
      return 'chat';
  }
}
