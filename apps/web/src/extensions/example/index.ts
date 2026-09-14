/**
 * The web half of the example extension: a page under `#/example`, a "More"
 * menu entry, a Settings module, translations, a chat card and an icon for its
 * tool, and agent-panel context for the page. Copy this folder to start your own.
 */
import { lazy } from 'react';
import { StickyNote } from '../../lib/icons';
import { translate, type Locale } from '../../lib/i18n';
import { defineWebExtension } from '../define';
import { exampleMessages } from './messages';
import { ExampleNotesCard } from './card';

const ExampleNotesPage = lazy(() => import('./page').then((m) => ({ default: m.ExampleNotesPage })));
const ExampleSettingsModule = lazy(() => import('./page').then((m) => ({ default: m.ExampleSettingsModule })));

/** Extension copy for imperative code: the current locale is stored by the i18n provider. */
function tx(key: string, params?: Record<string, string | number>): string {
  const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem('app-locale');
  const locale: Locale = stored === 'zh' ? 'zh' : 'en';
  return translate(locale, `ext.example.${key}`, params);
}

export const exampleWebExtension = defineWebExtension({
  id: 'example',
  messages: exampleMessages,
  pages: [{ route: 'example', component: ExampleNotesPage, titleKey: 'ext.example.title' }],
  navigation: [
    {
      id: 'example',
      labelKey: 'ext.example.nav',
      icon: StickyNote,
      href: '#/example',
      route: 'example',
      requireFeature: 'example',
    },
  ],
  modules: [
    {
      key: 'example',
      parent: 'settings',
      labelKey: 'ext.example.settings.title',
      descriptionKey: 'ext.example.settings.description',
      icon: StickyNote,
      component: ExampleSettingsModule,
      requireFeature: 'example',
    },
  ],
  toolCards: [{ tool: 'example_notes_query', component: ExampleNotesCard }],
  toolIcons: { example_notes_query: StickyNote },
  contextProvider: {
    type: 'extension',
    label: () => tx('context.label'),
    emptyMessage: () => tx('context.empty'),
    quickActions: () => [{ icon: StickyNote, label: tx('context.summarize'), msg: tx('context.summarize') }],
    contextHint: () => tx('context.hint'),
  },
});
