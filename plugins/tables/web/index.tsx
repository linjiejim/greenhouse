import React, { lazy } from 'react';
import manifest from '../manifest.js';
import {
  defineWebExtension,
  Table2,
  Columns3,
  Edit3,
  Database,
  usePlatformCatalog,
  useT,
  Spinner,
  isRowId,
} from '@greenhouse/web/extension-kit';
import { TablesNavPanel } from './sidebar.js';
import { SchemaPlanCard, type TablesSchemaPlanArtifact } from './components/schema-plan-card.js';
import context from './context.js';
import en from './messages/en.js';
import zh from './messages/zh.js';
const TablesPage = lazy(() => import('./pages/index.js').then((m) => ({ default: m.TablesPage })));
function Page({ subPath }: { subPath: string }) {
  const { hasApplication, loading } = usePlatformCatalog();
  const t = useT();
  if (loading) return <Spinner />;
  if (!hasApplication('tables')) return <div>{t('app.noPermission')}</div>;
  return <TablesPage subPath={subPath} />;
}
export default defineWebExtension({
  ...manifest,
  messages: { en, zh },
  pages: [
    {
      route: 'tables',
      applicationId: 'tables',
      component: Page,
      titleKey: 'ext.tables.navigation.tables',
      sidebarPanel: TablesNavPanel,
      modules: [
        {
          key: '',
          labelKey: 'ext.tables.navigation.tables',
          descriptionKey: 'ext.tables.navigation.tablesDesc',
          icon: Table2,
        },
        {
          key: 'catalog',
          labelKey: 'ext.tables.navigation.dataCatalog',
          descriptionKey: 'ext.tables.navigation.dataCatalogDesc',
          icon: Database,
          hiddenFromNav: true,
        },
      ],
    },
  ],
  entityKinds: [{ kind: 'tables_record', icon: Table2, fallbackTitleKey: 'ext.tables.record' }],
  entitySync: { tables_mutation: 'tables' },
  contextProviders: [context],
  resolveContext: (_route, subPath) => {
    const segments = subPath.split('/');
    return {
      type: 'tables',
      baseId: isRowId(segments[0]) ? segments[0] : undefined,
      tableId: segments[1] === 'table' && isRowId(segments[2]) ? segments[2] : undefined,
    };
  },
  toolIcons: { tables_query: Table2, tables_mutation: Edit3, tables_schema_plan: Columns3 },
  toolCards: [
    {
      tool: 'tables_schema_plan',
      placement: 'below',
      matches: (out) => !!out && typeof out === 'object' && 'type' in out && out.type === 'tables_schema_plan',
      component: ({ call, actionId, sessionId }) => (
        <SchemaPlanCard artifact={call.output as TablesSchemaPlanArtifact} actionId={actionId} sessionId={sessionId} />
      ),
    },
  ],
  mcpGroups: [{ id: 'tables', labelKey: 'ext.tables.mcp.label', descriptionKey: 'ext.tables.mcp.description' }],
});
