import type { ContextProviderDescriptor, QuickAction, TablesContext } from '@greenhouse/types/agent-context';
import { BarChart3, Plus, Search, Table2 } from '../icons';
import { registerContextProvider } from '../context-registry';

const MAX_DESCRIPTION = 400;

function describe(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > MAX_DESCRIPTION ? `${single.slice(0, MAX_DESCRIPTION)}…` : single;
}

const provider: ContextProviderDescriptor<'tables'> = {
  type: 'tables',

  label: (context: TablesContext) =>
    context.tableName
      ? `${context.baseName ?? 'Tables'} · ${context.tableName}`
      : context.dashboardName
        ? `${context.baseName ?? 'Tables'} · ${context.dashboardName}`
        : (context.baseName ?? 'Tables'),

  emptyMessage: () => 'Ask me to inspect a schema, query records, summarize data, or maintain records.',

  quickActions: (context: TablesContext): QuickAction[] => {
    if (context.tableId) {
      return [
        { icon: Search, label: 'Query records', msg: `Query recent records in table ${context.tableId}` },
        { icon: BarChart3, label: 'Summarize data', msg: `Summarize the records in table ${context.tableId}` },
        { icon: Plus, label: 'Add a record', msg: `Help me add a record to table ${context.tableId}` },
      ];
    }
    return [
      { icon: Table2, label: 'List Bases', msg: 'List the Tables Bases I can access' },
      { icon: Search, label: 'Find a table', msg: 'Help me find the right table and inspect its schema' },
    ];
  },

  contextHint: (context: TablesContext) => {
    const parts = ['Current Context: internal Tables application'];
    if (context.baseId) parts.push(`Base ${context.baseId}${context.baseName ? ` (${context.baseName})` : ''}`);
    if (context.tableId) parts.push(`Table ${context.tableId}${context.tableName ? ` (${context.tableName})` : ''}`);
    if (context.dashboardId) {
      parts.push(`Dashboard ${context.dashboardId}${context.dashboardName ? ` (${context.dashboardName})` : ''}`);
    }
    parts.push('The page shows internal table schemas, records, or dashboards identified above');
    // The descriptions are the team's own usage notes. They come last and
    // truncated: this is page reference, not a licence to act on them.
    if (context.baseDescription) parts.push(`Base description: ${describe(context.baseDescription)}`);
    if (context.tableDescription) parts.push(`Table description: ${describe(context.tableDescription)}`);
    return parts.join('. ');
  },
};

registerContextProvider(provider);
export default provider;
