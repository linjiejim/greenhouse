import type { PageContext } from '@greenhouse/types/agent-context';

/** Stable identity for the current route-level Assistant context. */
export function pageContextKey(context: PageContext | null): string {
  if (!context) return '';
  switch (context.type) {
    case 'chat':
      return `${context.type}:${context.sessionId || ''}`;
    case 'eval':
      return `${context.type}:${context.runId || ''}`;
    case 'project-detail':
      return `${context.type}:${context.projectId}`;
    case 'tables':
      return `${context.type}:${context.baseId || ''}:${context.tableId || ''}:${context.dashboardId || ''}`;
    case 'execution-center':
      return `${context.type}:${context.runKind || ''}:${context.runId || ''}`;
    default:
      return context.type;
  }
}
