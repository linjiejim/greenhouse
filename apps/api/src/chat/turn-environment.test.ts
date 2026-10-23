/**
 * admitTurnEnvironment — which ambient context and Client Actions a chat turn
 * actually gets. A client that stops meeting these rules loses its actions with
 * no error, so the rules are pinned here rather than inferred from a client.
 */

import { describe, expect, it } from 'vitest';
import type { AmbientContextEnvelope } from '@greenhouse/types/agent-context';
import { admitTurnEnvironment } from './turn-environment.js';

const ACTIONS = [
  { name: 'read_current_view', description: 'Read the page', parameters: { type: 'object', properties: {} } },
  { name: 'navigate', description: 'Go somewhere', parameters: { type: 'object', properties: {} } },
];

function ambient(scopeId: string): AmbientContextEnvelope {
  return { version: 1, scope_id: scopeId, source: 'current-page', label: 'Pricing', route: '#/knowledge', hint: 'h' };
}

describe('admitTurnEnvironment', () => {
  it('registers the advertised actions for a persisted session with a scope', () => {
    const turn = admitTurnEnvironment({ client_actions: ACTIONS, client_action_scope_id: 'page:1' }, 'session-1');

    expect(turn.usesClientActions).toBe(true);
    expect(turn.clientActions.map((a) => a.name)).toEqual(['read_current_view', 'navigate']);
    expect(turn.clientActionScopeId).toBe('page:1');
    expect(turn.ambientContext).toBeUndefined();
  });

  it('passes matching ambient context through unchanged', () => {
    const context = ambient('page:1');
    const turn = admitTurnEnvironment(
      { ambient_context: context, client_actions: ACTIONS, client_action_scope_id: 'page:1' },
      'session-1',
    );

    expect(turn.ambientContext).toEqual(context);
    expect(turn.usesClientActions).toBe(true);
  });

  it('ignores actions on a stateless turn: results could never be correlated', () => {
    const turn = admitTurnEnvironment({ client_actions: ACTIONS, client_action_scope_id: 'page:1' }, undefined);
    expect(turn.usesClientActions).toBe(false);
  });

  it('fails closed when the actions and the ambient context describe different pages', () => {
    const turn = admitTurnEnvironment(
      { ambient_context: ambient('page:1'), client_actions: ACTIONS, client_action_scope_id: 'page:2' },
      'session-1',
    );
    expect(turn.usesClientActions).toBe(false);
  });

  it('needs a scope id to register anything', () => {
    expect(admitTurnEnvironment({ client_actions: ACTIONS }, 'session-1').usesClientActions).toBe(false);
  });
});
