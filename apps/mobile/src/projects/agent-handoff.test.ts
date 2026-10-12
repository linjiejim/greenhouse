/** "Hand to Agent" rules (./agent-handoff.ts): who can take it, who has it, why it was refused. */

import { describe, expect, it } from 'vitest';
import type { BotView } from '../shared/bots';
import { handoffAgents, handoffErrorKey, taskAgent } from './agent-handoff';

const bot = (id: string, over: Partial<BotView> = {}): BotView =>
  ({ id, name: id, template_key: null, status: 'active', ...over }) as BotView;

describe('handoffAgents', () => {
  it('active Agents only, the main Agent first, the rest in their order', () => {
    const list = [bot('fern'), bot('old', { status: 'archived' }), bot('sprouty', { template_key: 'sprouty' }), bot('ivy')];
    expect(handoffAgents(list).map((b) => b.id)).toEqual(['sprouty', 'fern', 'ivy']);
    expect(handoffAgents([])).toEqual([]);
  });
});

describe('taskAgent', () => {
  const byId = { fern: { name: 'Fern' } };

  it('never handed: nothing to show', () => {
    expect(taskAgent({ agent_id: null, agent_session_id: null }, byId)).toBeNull();
    expect(taskAgent({}, byId)).toBeNull();
  });

  it('the member’s own Agent: its name and its chat', () => {
    expect(taskAgent({ agent_id: 'fern', agent_session_id: 's1' }, byId)).toEqual({ name: 'Fern', sessionId: 's1' });
  });

  it('someone else’s Agent (Agents are private): no name, no chat to open', () => {
    expect(taskAgent({ agent_id: 'theirs', agent_session_id: 's2' }, byId)).toEqual({ name: null, sessionId: null });
  });
});

describe('handoffErrorKey', () => {
  it('explains Agents off and gone; anything else says only the title', () => {
    expect(handoffErrorKey(403)).toBe('projects.handOff');
    expect(handoffErrorKey(404)).toBe('projects.handGone');
    expect(handoffErrorKey(0)).toBeNull();
    expect(handoffErrorKey(500)).toBeNull();
  });
});
