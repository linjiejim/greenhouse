/**
 * Knowledge write-back — the "grow the knowledge base" client action.
 *
 * Advertised to /api/chat as a client_action alongside the browser_* tools.
 * Unlike the browser actions (which run in the page), this one is executed by
 * POSTing to the confirm-gated agent proxy /api/agent/tools/knowledge_mutation/
 * call (see lib/knowledge-tools.ts). The extension also sends omit_write_tools
 * so the inline knowledge_mutation is NOT offered in the stream — this action is
 * the single, always-confirmed write path from the panel.
 */

import type { ClientActionDescriptor } from '@greenhouse/types/api';

export const KNOWLEDGE_ACTION_NAME = 'save_to_knowledge';

export const KNOWLEDGE_ACTION_DESCRIPTOR: ClientActionDescriptor = {
  name: KNOWLEDGE_ACTION_NAME,
  description:
    'Save or append content to the Greenhouse knowledge base. This is the ONLY way to write to the knowledge base from this browser panel, and it ALWAYS shows the user a confirmation card before saving — call it directly when the user asks to save/record/记录/存入 something; do not ask for permission in prose first. Use mode "create" for a new document (needs title + content) or "append" to add to an existing one (needs doc_id + content). Content is Markdown. Prefer scope "personal" unless the user says it is for the team.',
  parameters: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['create', 'append'],
        description: 'create = new document; append = add to an existing document (requires doc_id).',
      },
      title: { type: 'string', description: 'Document title (required for create).' },
      content: { type: 'string', description: 'Markdown content to save (create) or append.' },
      scope: {
        type: 'string',
        enum: ['personal', 'team'],
        description: 'personal = only you; team = shared team doc. Default personal.',
      },
      doc_id: { type: 'string', description: 'Existing document id (required for append; from knowledge_query).' },
    },
    required: ['mode', 'content'],
  },
};
