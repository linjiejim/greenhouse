import {
  Activity,
  Bell,
  MessageSquare,
  Settings,
  Shield,
  Sparkles,
  Table2,
  Wand2,
  type LucideIcon,
} from 'lucide-react';
import type { MessageKey } from '../i18n/zh';
import type { Route } from '../lib/router';

/** The modules this build has. Knowledge and apps join in M2. */
export type ModuleId = 'chat' | 'tables' | 'agents' | 'skills' | 'runs' | 'notifications' | 'settings' | 'admin';

export const MODULES: Record<ModuleId, { label: MessageKey; icon: LucideIcon }> = {
  chat: { label: 'nav.chat', icon: MessageSquare },
  tables: { label: 'nav.tables', icon: Table2 },
  agents: { label: 'nav.agents', icon: Sparkles },
  skills: { label: 'nav.skills', icon: Wand2 },
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
    case 'skills':
    case 'skill':
      return 'skills';
    case 'tables':
    case 'base':
      return 'tables';
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
