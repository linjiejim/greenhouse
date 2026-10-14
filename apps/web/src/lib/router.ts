/**
 * Hash routes (PRD §6.4). `#/` is the main thread. Pages read the route with useRoute and
 * move with navigate or <a href={href(route)}>.
 */

import { useSyncExternalStore } from 'react';
import type { KnowledgeScope } from '@greenhouse/contract';

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
/** 技能: everything I can see, the team's, my own, those waiting for my review, archived. */
export const SKILL_SCOPES = ['all', 'team', 'mine', 'review', 'archived'] as const;
/** 知识库 spaces: the team's, mine, and what others shared with me. */
export const KNOWLEDGE_SCOPES = ['team', 'personal', 'shared'] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
export type AdminSection = (typeof ADMIN_SECTIONS)[number];
export type AgentScope = (typeof AGENT_SCOPES)[number];
export type AgentTab = (typeof AGENT_TABS)[number];
export type RunView = (typeof RUN_VIEWS)[number];
export type SkillScope = (typeof SKILL_SCOPES)[number];

export type Route =
  /** `main`, `new` (optionally with the Agent to ask and a skill to run), or a conversation id. */
  | { page: 'conversation'; id: string; agent?: string; skill?: string }
  | { page: 'agents'; scope: AgentScope }
  | { page: 'agent'; id: string; tab: AgentTab }
  | { page: 'runs'; view: RunView }
  | { page: 'run'; id: string }
  | { page: 'skills'; scope: SkillScope }
  | { page: 'skill'; id: string }
  /**
   * 知识库 (KNOW-01): the recent docs without `space`; the root of a space with it; what was
   * archived in a space (team or personal) with `archived`. `file` previews a file over the list.
   */
  | { page: 'knowledge'; space?: KnowledgeScope; archived?: boolean; file?: string }
  | { page: 'folder'; id: string; file?: string }
  /** A doc, read or (`edit`) being changed. */
  | { page: 'doc'; id: string; edit?: boolean }
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
  const file = query.get('file');
  if (head === 'knowledge') {
    if (parts.length > 3 || (extra !== undefined && id !== 'folder')) return notFound;
    if (id === 'folder') return extra ? { page: 'folder', id: extra, ...(file ? { file } : {}) } : notFound;
    if (id) return query.get('edit') === '1' ? { page: 'doc', id, edit: true } : { page: 'doc', id };
    const space = query.get('space');
    if (!KNOWLEDGE_SCOPES.includes(space as KnowledgeScope)) return { page: 'knowledge' };
    const archived = query.get('view') === 'archived' && space !== 'shared';
    return {
      page: 'knowledge',
      space: space as KnowledgeScope,
      ...(archived ? { archived } : {}),
      ...(file ? { file } : {}),
    };
  }
  if (extra !== undefined) return notFound;
  switch (head) {
    case undefined:
      return { page: 'conversation', id: 'main' };
    case 'c': {
      if (id !== 'new') return { page: 'conversation', id: id ?? 'main' };
      const agent = query.get('agent');
      const skill = query.get('skill');
      return { page: 'conversation', id: 'new', ...(agent ? { agent } : {}), ...(skill ? { skill } : {}) };
    }
    case 'agents':
      return id
        ? { page: 'agent', id, tab: pick(AGENT_TABS, query.get('tab'), 'profile') }
        : { page: 'agents', scope: pick(AGENT_SCOPES, query.get('scope'), 'mine') };
    case 'runs':
      return id ? { page: 'run', id } : { page: 'runs', view: pick(RUN_VIEWS, query.get('view'), 'active') };
    case 'skills':
      return id ? { page: 'skill', id } : { page: 'skills', scope: pick(SKILL_SCOPES, query.get('scope'), 'all') };
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
    case 'conversation': {
      const query = new URLSearchParams({
        ...(route.agent ? { agent: route.agent } : {}),
        ...(route.skill ? { skill: route.skill } : {}),
      }).toString();
      return `#/c/${encodeURIComponent(route.id)}${query ? `?${query}` : ''}`;
    }
    case 'agents':
      return route.scope === 'mine' ? '#/agents' : `#/agents?scope=${route.scope}`;
    case 'agent':
      return `#/agents/${encodeURIComponent(route.id)}${route.tab === 'profile' ? '' : `?tab=${route.tab}`}`;
    case 'runs':
      return route.view === 'active' ? '#/runs' : `#/runs?view=${route.view}`;
    case 'run':
      return `#/runs/${encodeURIComponent(route.id)}`;
    case 'skills':
      return route.scope === 'all' ? '#/skills' : `#/skills?scope=${route.scope}`;
    case 'skill':
      return `#/skills/${encodeURIComponent(route.id)}`;
    case 'knowledge': {
      const query = new URLSearchParams({
        ...(route.space ? { space: route.space } : {}),
        ...(route.space && route.archived ? { view: 'archived' } : {}),
        ...(route.space && route.file ? { file: route.file } : {}),
      }).toString();
      return `#/knowledge${query ? `?${query}` : ''}`;
    }
    case 'folder':
      return `#/knowledge/folder/${encodeURIComponent(route.id)}${route.file ? `?file=${encodeURIComponent(route.file)}` : ''}`;
    case 'doc':
      return `#/knowledge/${encodeURIComponent(route.id)}${route.edit ? '?edit=1' : ''}`;
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

/** A page holding unsaved work (holdNavigation): where it is, and what to ask before leaving it. */
let hold: { at: string; attempt: (to: string) => void } | null = null;

/**
 * Holds navigation while a page has unsaved work: links, navigate(), Back and Forward ask
 * `onAttempt` with where they were going instead of leaving, and closing or reloading the tab asks
 * the browser's own question. The page decides, then releases and navigates with `force`.
 * Returns the release.
 */
export function holdNavigation(onAttempt: (to: string) => void): () => void {
  const mine = { at: location.hash, attempt: (to: string) => onAttempt(to) };
  hold = mine;
  const onClick = (event: MouseEvent) => {
    if (hold !== mine || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element | null)?.closest?.('a[href^="#"]');
    if (!link || link.closest('[contenteditable="true"]') || link.getAttribute('target')) return;
    const to = link.getAttribute('href') ?? '';
    if (to === mine.at) return;
    event.preventDefault();
    mine.attempt(to);
  };
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    event.preventDefault();
    event.returnValue = '';
  };
  document.addEventListener('click', onClick, true);
  window.addEventListener('beforeunload', onBeforeUnload);
  return () => {
    document.removeEventListener('click', onClick, true);
    window.removeEventListener('beforeunload', onBeforeUnload);
    if (hold === mine) hold = null;
  };
}

export function navigate(to: Route | string, options: { replace?: boolean; force?: boolean } = {}) {
  const target = typeof to === 'string' ? to : href(to);
  if (target === location.hash) return;
  if (hold && !options.force) return hold.attempt(target);
  // Leaving anyway: the hold lets this one through.
  if (options.force) hold = null;
  if (options.replace) {
    history.replaceState(history.state, '', target);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = target;
  }
}

/**
 * Back and Forward cannot be stopped, only undone: while a page holds, the address goes back to it
 * before anyone reads the new route, and the page is asked. True when it was held.
 */
function held(): boolean {
  if (!hold || location.hash === hold.at) return false;
  const to = location.hash;
  history.pushState(history.state, '', hold.at);
  hold.attempt(to);
  return true;
}

function subscribe(onChange: () => void) {
  const listener = () => {
    if (!held()) onChange();
  };
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

let cached: { hash: string; route: Route } | null = null;
function snapshot(): Route {
  if (cached?.hash !== location.hash) cached = { hash: location.hash, route: parse(location.hash) };
  return cached.route;
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
