import React, { lazy } from 'react';
import manifest from '../manifest.js';
import {
  defineWebExtension,
  BookOpen,
  Search,
  translate,
  Edit3,
  FileText,
  Spinner,
  useT,
  usePlatformCatalog,
} from '@greenhouse/web/extension-kit';
import { KnowledgeNavPanel } from './sidebar/knowledge-nav-panel.js';
import { useKnowledgeStore } from './store.js';
import en from './messages/en.js';
import zh from './messages/zh.js';
import { TeamDocumentPicker } from './team-context-picker.js';
const KnowledgePage = lazy(() => import('./page.js').then((m) => ({ default: m.KnowledgePage })));
const Peek = lazy(() => import('./peek.js').then((m) => ({ default: m.KnowledgeDocPeek })));
function Page({ subPath }: { subPath: string }) {
  const { hasApplication, loading } = usePlatformCatalog();
  const t = useT();
  if (loading) return <Spinner />;
  return hasApplication('knowledge') ? (
    <KnowledgePage subPath={subPath} basePath="#/knowledge" />
  ) : (
    <div>{t('app.noPermission')}</div>
  );
}
export default defineWebExtension({
  ...manifest,
  messages: { en, zh },
  defaultQuickActions: () => {
    const locale = typeof localStorage !== 'undefined' && localStorage.getItem('app-locale') === 'zh' ? 'zh' : 'en';
    return [
      {
        icon: Search,
        label: translate(locale, 'ext.knowledge.searchAction'),
        msg: translate(locale, 'ext.knowledge.searchPrompt'),
      },
    ];
  },
  pages: [
    {
      route: 'knowledge',
      applicationId: 'knowledge',
      navigationOrder: 10,
      component: Page,
      titleKey: 'ext.knowledge.title',
      sidebarPanel: ({ subPath, onNavigate }) => <KnowledgeNavPanel activeModule={subPath} onNavigate={onNavigate} />,
    },
  ],
  slots: [{ slot: 'team-context.documents', component: TeamDocumentPicker }],
  entityKinds: [
    {
      kind: 'kb_doc',
      icon: FileText,
      fallbackTitleKey: 'ext.knowledge.entityTitle',
      render: (ref) => <Peek id={String(ref.id)} />,
    },
  ],
  onReconnect: () => useKnowledgeStore.getState().remoteChanged(),
  entitySync: { knowledge_mutation: 'knowledge' },
  wsEvents: [
    (event) => {
      if (event.type === 'knowledge.changed') useKnowledgeStore.getState().remoteChanged();
    },
  ],
  toolIcons: { knowledge_query: BookOpen, knowledge_mutation: Edit3 },
  mcpGroups: [
    { id: 'knowledge', labelKey: 'ext.knowledge.mcp.label', descriptionKey: 'ext.knowledge.mcp.description' },
  ],
});
