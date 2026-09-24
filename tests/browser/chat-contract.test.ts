/**
 * Contract: what the Greenhouse Bridge side panel sends vs. what the API accepts.
 *
 * Runs the extension's REAL request builders against the server's REAL admission
 * code. The panel once kept sending `context_hint` / `omit_write_tools` to a
 * server that had stopped reading them, and posting action results to a route
 * that had been renamed: nothing errored, the page context and the browser tools
 * just vanished and the model got its write tools back. That drift fails here.
 *
 * The result route itself: the panel posts to CLIENT_ACTION_RESULT_PATH from
 * @greenhouse/types, and apps/api/src/routes/__tests__/client-actions-route.test.ts
 * holds the server to serving it.
 */

import { describe, expect, it } from 'vitest';
import { CHAT_REQUEST_BODY_KEYS } from '@greenhouse/types/api';
import { AMBIENT_CONTEXT_LIMITS } from '@greenhouse/types/agent-context';
import { admitTurnEnvironment } from '../../apps/api/src/chat/turn-environment';
import { knowledgeMutationSchema } from '../../apps/api/src/tools/knowledge-mutation';
import { MUTATING_PROXY_ALLOWLIST } from '../../apps/api/src/tools/registry';
import { buildChatRequestBody, newTurnScopeId, PANEL_CLIENT_ACTIONS } from '../../apps/browser/src/lib/chat-request';
import {
  buildKnowledgeMutationInput,
  KNOWLEDGE_MUTATION_CALL_PATH,
  type KnowledgeWriteRequest,
} from '../../apps/browser/src/lib/knowledge-actions';
import { buildPageAmbientContext, type PageContext } from '../../apps/browser/src/lib/page-context';

const PAGE: PageContext = { tabId: 3, url: 'https://example.com/docs/pricing', title: 'Pricing', permitted: true };

/** One panel turn, built exactly as the side panel builds it. */
function panelTurn(page?: { ctx?: Partial<PageContext>; fullPageText?: string }) {
  const scopeId = newTurnScopeId();
  const ambientContext = page
    ? buildPageAmbientContext({ ...PAGE, ...page.ctx }, scopeId, page.fullPageText)
    : undefined;
  return buildChatRequestBody({ sessionId: 'session-1', message: 'What does this cost?', scopeId, ambientContext });
}

const TURNS = {
  'no page context': panelTurn(),
  'a selection': panelTurn({ ctx: { selection: 'The Pro plan is $12 per seat.' } }),
  'nothing selected': panelTurn({ ctx: {} }),
  'summarize page': panelTurn({ fullPageText: 'Pricing page body. '.repeat(40) }),
};

describe('Greenhouse Bridge → POST /api/chat', () => {
  it.each(Object.entries(TURNS))('sends only fields the route reads (%s)', (_name, body) => {
    const accepted = new Set<string>(CHAT_REQUEST_BODY_KEYS);
    expect(Object.keys(body).filter((key) => !accepted.has(key))).toEqual([]);
  });

  it.each(Object.entries(TURNS))('gets every panel action registered for the turn (%s)', (_name, body) => {
    const turn = admitTurnEnvironment(body, 'session-1');

    expect(turn.usesClientActions).toBe(true);
    expect(turn.clientActions.map((a) => a.name)).toEqual(PANEL_CLIENT_ACTIONS.map((a) => a.name));
    expect(turn.clientActionScopeId).toBe(body.client_action_scope_id);
  });

  it.each(Object.entries(TURNS).filter(([, body]) => body.ambient_context))(
    'gets its page context through unchanged (%s)',
    (_name, body) => {
      expect(admitTurnEnvironment(body, 'session-1').ambientContext).toEqual(body.ambient_context);
    },
  );

  it('sizes an oversized page to the caps instead of being cut server-side', () => {
    const body = panelTurn({
      ctx: { title: 'T'.repeat(500), url: `https://example.com/${'p'.repeat(900)}` },
      fullPageText: 'x'.repeat(AMBIENT_CONTEXT_LIMITS.hint * 3),
    });
    const sent = body.ambient_context!;

    expect(sent.label.length).toBeLessThanOrEqual(AMBIENT_CONTEXT_LIMITS.label);
    expect(sent.route.length).toBeLessThanOrEqual(AMBIENT_CONTEXT_LIMITS.route);
    expect(sent.hint.length).toBeLessThanOrEqual(AMBIENT_CONTEXT_LIMITS.hint);
    expect(sent.hint.endsWith('"""')).toBe(true);
    expect(admitTurnEnvironment(body, 'session-1').ambientContext).toEqual(sent);
  });
});

describe('Greenhouse Bridge → knowledge write-back', () => {
  const saves: KnowledgeWriteRequest[] = [
    { mode: 'create', scope: 'personal', title: 'Pricing notes', content: '# Pricing\nPro is $12.' },
    { mode: 'append', scope: 'team', docId: 'doc-1', content: 'Seen on example.com.' },
  ];

  it('goes through the confirm-gated proxy, which exposes knowledge_mutation as a write', () => {
    expect(KNOWLEDGE_MUTATION_CALL_PATH).toBe('/api/agent/tools/knowledge_mutation/call');
    expect(MUTATING_PROXY_ALLOWLIST.has('knowledge_mutation')).toBe(true);
  });

  it.each(saves.map((save) => [save.mode, save] as const))('builds a %s the tool schema accepts', (_mode, save) => {
    expect(knowledgeMutationSchema.safeParse(buildKnowledgeMutationInput(save)).success).toBe(true);
  });
});
