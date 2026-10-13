/**
 * Hash routes (PRD §6.4). `#/` is the main thread. Pages read the route with useRoute and
 * move with navigate or <a href={href(route)}>.
 */

import { useSyncExternalStore } from 'react';

export const SETTINGS_SECTIONS = ['account', 'notifications', 'connections', 'vault', 'services', 'access'] as const;
export const ADMIN_SECTIONS = [
  'members',
  'services',
  'usage',
  'connectors',
  'access',
  'public-agents',
  'branding',
] as const;
export const AGENT_SCOPES = ['mine', 'public', 'archived'] as const;
export const AGENT_TABS = ['profile', 'abilities', 'memory', 'schedules', 'computer', 'publish', 'activity'] as const;
export const RUN_VIEWS = ['active', 'scheduled', 'done'] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
export type AdminSection = (typeof ADMIN_SECTIONS)[number];
export type AgentScope = (typeof AGENT_SCOPES)[number];
export type AgentTab = (typeof AGENT_TABS)[number];
export type RunView = (typeof RUN_VIEWS)[number];

export type Route =
  /** `main`, `new` (optionally with the Agent to ask), or a conversation id. */
  | { page: 'conversation'; id: string; agent?: string }
  | { page: 'agents'; scope: AgentScope }
  | { page: 'agent'; id: string; tab: AgentTab }
  | { page: 'runs'; view: RunView }
  | { page: 'run'; id: string }
  | { page: 'notifications'; view: 'needs' | 'all' }
  | { page: 'settings'; section: SettingsSection }
  | { page: 'admin'; section: AdminSection }
  | { page: 'activate'; token: string }
  /** AUTH-06: an outside app asks for access (`request`), or its link was bad (`error`). */
  | { page: 'consent'; request: string; error: string }
  | { page: 'not-found'; path: string };

export type Page = Route['page'];

const pick = <T extends string>(values: readonly T[], value: string | null | undefined, fallback: T): T =>
  values.includes(value as T) ? (value as T) : fallback;

export function parse(hash: string): Route {
  const [path = '', search = ''] = hash.replace(/^#/, '').split('?');
  const query = new URLSearchParams(search);
  const parts = path
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  const [head, id, extra] = parts;
  const notFound = { page: 'not-found', path } as const;
  if (extra !== undefined) return notFound;
  switch (head) {
    case undefined:
      return { page: 'conversation', id: 'main' };
    case 'c': {
      const agent = id === 'new' ? query.get('agent') : null;
      return agent ? { page: 'conversation', id: 'new', agent } : { page: 'conversation', id: id ?? 'main' };
    }
    case 'agents':
      return id
        ? { page: 'agent', id, tab: pick(AGENT_TABS, query.get('tab'), 'profile') }
        : { page: 'agents', scope: pick(AGENT_SCOPES, query.get('scope'), 'mine') };
    case 'runs':
      return id ? { page: 'run', id } : { page: 'runs', view: pick(RUN_VIEWS, query.get('view'), 'active') };
    case 'notifications':
      return id ? notFound : { page: 'notifications', view: query.get('view') === 'all' ? 'all' : 'needs' };
    case 'settings':
      return { page: 'settings', section: pick(SETTINGS_SECTIONS, id, 'account') };
    case 'admin':
      return { page: 'admin', section: pick(ADMIN_SECTIONS, id, 'members') };
    case 'activate':
      return { page: 'activate', token: query.get('token') ?? '' };
    case 'oauth':
      return id === 'consent'
        ? { page: 'consent', request: query.get('request') ?? '', error: query.get('error') ?? '' }
        : notFound;
    default:
      return notFound;
  }
}

export function href(route: Route): string {
  switch (route.page) {
    case 'conversation':
      return `#/c/${encodeURIComponent(route.id)}${route.agent ? `?agent=${encodeURIComponent(route.agent)}` : ''}`;
    case 'agents':
      return route.scope === 'mine' ? '#/agents' : `#/agents?scope=${route.scope}`;
    case 'agent':
      return `#/agents/${encodeURIComponent(route.id)}${route.tab === 'profile' ? '' : `?tab=${route.tab}`}`;
    case 'runs':
      return route.view === 'active' ? '#/runs' : `#/runs?view=${route.view}`;
    case 'run':
      return `#/runs/${encodeURIComponent(route.id)}`;
    case 'notifications':
      return route.view === 'all' ? '#/notifications?view=all' : '#/notifications';
    case 'settings':
      return `#/settings/${route.section}`;
    case 'admin':
      return `#/admin/${route.section}`;
    case 'activate':
      return `#/activate?token=${encodeURIComponent(route.token)}`;
    case 'consent': {
      const query = new URLSearchParams();
      if (route.request) query.set('request', route.request);
      if (route.error) query.set('error', route.error);
      const text = query.toString();
      return `#/oauth/consent${text ? `?${text}` : ''}`;
    }
    case 'not-found':
      return `#/${route.path.replace(/^\//, '')}`;
  }
}

export function navigate(to: Route | string, options: { replace?: boolean } = {}) {
  const target = typeof to === 'string' ? to : href(to);
  if (target === location.hash) return;
  if (options.replace) {
    history.replaceState(history.state, '', target);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = target;
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

let cached: { hash: string; route: Route } | null = null;
function snapshot(): Route {
  if (cached?.hash !== location.hash) cached = { hash: location.hash, route: parse(location.hash) };
  return cached.route;
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
