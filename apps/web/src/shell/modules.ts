import {
  Activity,
  Bell,
  BookOpen,
  MessageSquare,
  Settings,
  Shield,
  Sparkles,
  Wand2,
  type LucideIcon,
} from 'lucide-react';
import type { MessageKey } from '../i18n/zh';
import type { Route } from '../lib/router';

/** The modules this build has. Tables and apps join in M2. */
export type ModuleId = 'chat' | 'knowledge' | 'agents' | 'skills' | 'runs' | 'notifications' | 'settings' | 'admin';

export const MODULES: Record<ModuleId, { label: MessageKey; icon: LucideIcon }> = {
  chat: { label: 'nav.chat', icon: MessageSquare },
  knowledge: { label: 'nav.knowledge', icon: BookOpen },
  agents: { label: 'nav.agents', icon: Sparkles },
  skills: { label: 'nav.skills', icon: Wand2 },
  runs: { label: 'nav.runs', icon: Activity },
  notifications: { label: 'nav.notifications', icon: Bell },
  settings: { label: 'nav.settings', icon: Settings },
  admin: { label: 'nav.admin', icon: Shield },
};

export function moduleOf(route: Route): ModuleId {
  switch (route.page) {
    case 'knowledge':
    case 'folder':
    case 'doc':
      return 'knowledge';
    case 'agents':
    case 'agent':
      return 'agents';
    case 'skills':
    case 'skill':
      return 'skills';
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
