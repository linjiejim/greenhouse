import { it, expect } from 'vitest';
import { lucideIcon, pluginIcon } from './icons';

it('maps lucide names in any spelling to the client icon set', () => {
  expect(lucideIcon('BookOpen')).toBe('book');
  expect(lucideIcon('book-open')).toBe('book');
  expect(lucideIcon('folder_kanban')).toBe('checklist');
  expect(lucideIcon('Brain')).toBe('brain');
  expect(lucideIcon('NoSuchIcon')).toBeUndefined();
  expect(lucideIcon(undefined)).toBeUndefined();
});

it('prefers the manifest icon, then the official screen icon, then the generic app tile', () => {
  expect(pluginIcon({ icon: 'Mail' }, { kind: 'native', screen: 'email' })).toBe('mail');
  expect(pluginIcon({ icon: 'Unknown' }, { kind: 'native', screen: 'knowledge' })).toBe('book');
  expect(pluginIcon({ icon: 'Unknown' }, { kind: 'embed' })).toBe('apps');
  expect(pluginIcon({})).toBe('apps');
});

it('gives every official plugin a specific icon', () => {
  const official = ['BookOpen', 'Table2', 'FolderKanban', 'Brain', 'Mail', 'Sparkles', 'MessageSquare', 'FileText', 'Calendar', 'Monitor', 'StickyNote'];
  for (const name of official) expect(lucideIcon(name), name).toBeDefined();
});
