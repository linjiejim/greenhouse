/**
 * Knowledge write-back executor.
 *
 * Runs the save_to_knowledge client action: gathers the write, asks the panel
 * to confirm it (always — knowledge writes are never silent), then executes it
 * through the confirm-gated agent proxy. Never throws — declines and failures
 * come back as `{ error }` for the model to react to.
 */

import { authFetch } from './auth';
import type { ActionResult } from './browser-tools';

const CONTENT_LIMIT = 20_000;

export interface KnowledgeConfirmRequest {
  mode: 'create' | 'append';
  scope: 'personal' | 'team';
  title?: string;
  docId?: string;
  content: string;
}

/** Panel gate: resolve true to save, false to decline. */
export type KnowledgeConfirmFn = (req: KnowledgeConfirmRequest) => Promise<boolean>;

function normalize(params: Record<string, unknown>): KnowledgeConfirmRequest | { error: string } {
  const mode = params.mode === 'append' ? 'append' : 'create';
  const scope = params.scope === 'team' ? 'team' : 'personal';
  const content = typeof params.content === 'string' ? params.content.trim() : '';
  const title = typeof params.title === 'string' ? params.title.trim() : '';
  const docId = typeof params.doc_id === 'string' ? params.doc_id.trim() : '';

  if (!content) return { error: 'content is required.' };
  if (content.length > CONTENT_LIMIT) return { error: `content is too long (max ${CONTENT_LIMIT} chars).` };
  if (mode === 'create' && !title) return { error: 'title is required to create a document.' };
  if (mode === 'append' && !docId) return { error: 'doc_id is required to append to a document.' };

  return { mode, scope, content, title: title || undefined, docId: docId || undefined };
}

/**
 * Execute save_to_knowledge. `profileId` is forwarded to the proxy so the
 * write resolves against the same profile the chat is using.
 */
export async function executeKnowledgeAction(
  params: Record<string, unknown>,
  confirm: KnowledgeConfirmFn,
  profileId: string,
): Promise<ActionResult> {
  try {
    const req = normalize(params);
    if ('error' in req) return req;

    const allowed = await confirm(req);
    if (!allowed) {
      return { error: 'User declined to save to the knowledge base. Do not retry — ask the user how to proceed.' };
    }

    const input =
      req.mode === 'create'
        ? { action: 'knowledge.create_doc', scope: req.scope, title: req.title, content: req.content }
        : { action: 'knowledge.append_doc', scope: req.scope, doc_id: req.docId, content: req.content };

    const res = await authFetch('/api/agent/tools/knowledge_mutation/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, confirm: true, profile_id: profileId }),
    });

    const body = (await res.json().catch(() => ({}))) as {
      output?: unknown;
      error?: { message?: string } | string;
    };
    if (!res.ok) {
      const msg = typeof body.error === 'string' ? body.error : (body.error?.message ?? `http_${res.status}`);
      return { error: msg };
    }
    // The tool's own result may still carry a domain error (e.g. title exists).
    const output = body.output as Record<string, unknown> | undefined;
    if (output && typeof output === 'object' && 'error' in output) {
      return { error: String((output as { error: unknown }).error) };
    }
    return { output: output ?? { ok: true } };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
