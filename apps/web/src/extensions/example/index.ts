/**
 * The web half of the example extension: a page under `#/example`, a "More"
 * menu entry, a Settings module, translations, a chat card and an icon for its
 * tool, and agent-panel context for the page. Copy this folder to start your own.
 */
import { createElement, lazy } from 'react';
import { StickyNote } from '../../lib/icons';
import { translate, type Locale } from '../../lib/i18n';
import { defineWebExtension } from '../define';
import { exampleMessages } from './messages';
import { ExampleNotesCard } from './card';

const ExampleNotesPage = lazy(() => import('./page').then((m) => ({ default: m.ExampleNotesPage })));
const ExampleNotePeek = lazy(() => import('./page').then((m) => ({ default: m.ExampleNotePeek })));
const ExampleDocPanel = lazy(() => import('./page').then((m) => ({ default: m.ExampleDocPanel })));
const ExampleSettingsModule = lazy(() => import('./page').then((m) => ({ default: m.ExampleSettingsModule })));
const ExampleAdminModule = lazy(() => import('./page').then((m) => ({ default: m.ExampleAdminModule })));

/** Extension copy for imperative code: the current locale is stored by the i18n provider. */
function tx(key: string, params?: Record<string, string | number>): string {
  const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem('app-locale');
  const locale: Locale = stored === 'zh' ? 'zh' : 'en';
  return translate(locale, `ext.example.${key}`, params);
}

export const exampleWebExtension = defineWebExtension({
  id: 'example',
  messages: exampleMessages,
  pages: [
    {
      route: 'example',
      component: ExampleNotesPage,
      titleKey: 'ext.example.title',
      // Sub-modules give `#/example/notes` a page identity (`example.notes`),
      // a breadcrumb and a rail entry. A one-screen page can omit this.
      modules: [{ key: 'notes', labelKey: 'ext.example.nav', descriptionKey: 'ext.example.intro', icon: StickyNote }],
      // A hash from before the extension existed: `#/example-notes/<tail>` → `#/example/notes/<tail>`.
      aliases: { 'example-notes': 'example/notes' },
    },
  ],
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
    {
      key: 'example',
      parent: 'administration',
      labelKey: 'ext.example.admin.title',
      descriptionKey: 'ext.example.admin.description',
      icon: StickyNote,
      component: ExampleAdminModule,
      requireRole: ['super'],
    },
  ],
  toolCards: [{ tool: 'example_notes_query', component: ExampleNotesCard }],
  toolIcons: { example_notes_query: StickyNote },
  // A record kind: `#/example/notes/42` opens a peek instead of navigating.
  entityKinds: [
    {
      kind: 'ext:example:note',
      icon: StickyNote,
      fallbackTitleKey: 'ext.example.entity.note',
      render: (ref) => createElement(ExampleNotePeek, { id: String(ref.id) }),
    },
  ],
  // Consent copy for the `mcp:example` group the API half registered.
  mcpGroups: [
    { id: 'example', labelKey: 'ext.example.mcpGroup.label', descriptionKey: 'ext.example.mcpGroup.description' },
  ],
  // A section on every knowledge document, to show the slot works.
  knowledgeDocPanels: [{ id: 'example-doc-note', component: ExampleDocPanel }],
  contextProvider: {
    type: 'extension',
    label: () => tx('context.label'),
    emptyMessage: () => tx('context.empty'),
    quickActions: () => [{ icon: StickyNote, label: tx('context.summarize'), msg: tx('context.summarize') }],
    contextHint: () => tx('context.hint'),
  },
});
