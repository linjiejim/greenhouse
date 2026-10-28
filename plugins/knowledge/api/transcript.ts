import type { ToolResultAdapter } from '@greenhouse/api/extension-kit';
export const knowledgeTranscript: ToolResultAdapter = {
  toolId: 'knowledge_query',
  legacyCalls: {
    get_team_knowledge: (input) => ({ action: 'get', ...input }),
    search_team_knowledge: (input) => ({ action: 'search', ...input }),
    get_personal_knowledge: (input) => ({ action: 'get', ...input }),
    search_personal_knowledge: (input) => ({ action: 'search', ...input }),
  },
  summarizeInput: (input) =>
    input.action === 'get' || input.action === 'versions'
      ? { action: input.action ?? '', scope: input.scope ?? '', doc_id: input.doc_id ?? '' }
      : {
          action: input.action ?? '',
          scope: input.scope ?? '',
          query: input.query ?? '',
          ...(input.folder ? { folder: input.folder } : {}),
        },
  summarizeOutput: (output) => {
    if (output.error) return { error: output.error };
    if (typeof output.total_folders === 'number') {
      return { action: 'folders', scope: output.scope, root: output.root, folders: output.total_folders };
    }
    if (Array.isArray(output.folders)) {
      return { action: 'tree', scope: output.scope, root: output.root, docs: output.total_docs };
    }
    if (Array.isArray(output.versions)) {
      return { action: 'versions', doc_id: output.doc_id, found: output.found };
    }
    if (Array.isArray(output.results)) {
      return {
        action: 'search',
        scope: output.scope,
        found: output.found,
        ...(output.weak_match ? { weak_match: true } : {}),
      };
    }
    return {
      action: 'get',
      scope: output.scope,
      doc_id: output.doc_id ?? output.source_id,
      title: output.title,
      chars: ((output.content as string) ?? '').length,
      ...(output.mode ? { mode: output.mode } : {}),
    };
  },
  references: (output) =>
    typeof output.doc_id === 'string' && typeof output.title === 'string'
      ? [
          {
            slug: output.doc_id,
            title: output.title || output.doc_id,
            type: 'kb_doc',
            ...(typeof output.url === 'string' ? { url: output.url } : {}),
            category: typeof output.folder === 'string' ? output.folder : undefined,
          },
        ]
      : [],
  relevance: (output) =>
    Array.isArray(output.results)
      ? output.results.flatMap((result) => {
          const key = result.doc_id ?? (result.id != null ? String(result.id) : '');
          return key && typeof result.relevance === 'number' ? [{ key, value: result.relevance }] : [];
        })
      : [],
};
