import manifest from '../manifest.js';
import { defineExtension, extensionPath, requireInternal, requireFeature } from '@greenhouse/api/extension-kit';
import { createServices } from './services.js';
import routes from './routes.js';
import { tablesRegistration } from './platform/application.js';
import { tablesQueryTool } from './tools/tables-query.js';
import { tablesMutationTool } from './tools/tables-mutation.js';
import { tablesSchemaPlanTool } from './tools/tables-schema-plan.js';
import { tablesBases } from './catalog.js';
import { tablesExportSource } from './export-source.js';
import { tablesDriveScope } from './drive.js';
import { tableChanges } from './recent-changes.js';
import { recordObjectRef } from './object-refs.js';
export default defineExtension({
  ...manifest,
  discriminators: {
    shareResources: ['table_base'],
    fileLinkTargets: ['table_record'],
    folderScopes: ['tables'],
    auditApps: ['tables'],
    artifactKinds: ['tables_schema_plan'],
  },
  services: createServices,
  tools: [tablesQueryTool, tablesMutationTool, tablesSchemaPlanTool],
  routes: [{ path: '/api/tables', app: routes, guards: [requireInternal(), requireFeature('tables')] }],
  applications: [
    {
      ...tablesRegistration,
      teamCapabilities: ['tables.*'],
      platformTools: { query: ['tables_query'], command: ['tables_mutation'] },
    },
  ],
  featureFlags: [
    {
      key: 'tables',
      label: 'Tables',
      description: 'Internal multidimensional tables, shared grid views, REST, and MCP access',
      defaultEnabled: true,
    },
  ],
  featurePoints: [
    {
      key: 'tables',
      title: 'Tables',
      description:
        'Internal multidimensional tables. Enabling this turns Tables on everywhere — app, REST, MCP, and chat.',
      icon: 'Table2',
      kind: 'app',
      group: 'basic',
      appId: 'tables',
      flag: 'tables',
      // tables_schema_plan rides the flag but declares no proxy/MCP surface —
      // schema editing is chat-only, where a human can press Confirm (spec D3).
      toolIds: ['tables_query', 'tables_mutation', 'tables_schema_plan'],
    },
  ],
  mcpGroups: ['tables'],
  entityKinds: [{ kind: 'tables_record', route: '#/tables/:baseId/table/:tableId?record=:id' }],
  exportSources: [tablesExportSource],
  driveScopes: [tablesDriveScope],
  catalogSources: [{ id: 'tables', replaceDefaultSource: true, load: tablesBases }],
  recentChanges: [{ id: 'tables', load: tableChanges }],
  objectRefs: [{ type: 'record', resolve: recordObjectRef }],
  activity: [
    {
      toolModules: { tables_mutation: 'tables' },
      actionEntities: { records: 'record' },
      toolWrites: { tables_mutation: { entity: 'record' } },
    },
  ],
  automationTools: [{ id: 'tables_mutation', labelKey: 'ext.tables.automationTool', tier: 'write', order: 50 }],
  hubContext: [
    {
      group: 'tables',
      description: 'Tables: structured team data (bases, tables, records)',
      toolIds: ['tables_query', 'tables_mutation'],
    },
  ],
  resetTables: [
    'table_recompute_jobs',
    'table_record_links',
    'table_records',
    'table_views',
    'table_field_dependencies',
    'table_fields',
    'table_schema_versions',
    'table_tables',
    'table_bases',
  ],
  migrations: { dir: extensionPath(import.meta.url, '../migrations') },
  commands: [
    {
      name: 'tables',
      usage: 'tables list-archived | restore-base <id> | restore-table <id>',
      run: async (args) => (await import('./cli/tables.js')).run(args),
    },
  ],
});
