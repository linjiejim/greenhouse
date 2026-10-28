import { describe, expect, it } from 'vitest';
import { plantForClient } from '../../../../../packages/types/src/plant-avatar';
import { agentPlant } from './agent-plant';

describe('a connected agent’s plant', () => {
  it('follows the client name like the web', () => {
    expect(agentPlant('Claude Code · MacBook').plant).toBe('fern');
    expect(agentPlant('Codex CLI').plant).toBe('opuntia');
    expect(agentPlant('Cursor').plant).toBe('clover');
    expect(agentPlant('Claude Code').tint).toBe('plant');
  });

  it('takes the plant the member chose', () => {
    expect(agentPlant('Codex', { plant: 'fern', tint: 'rose' })).toMatchObject({ plant: 'fern', tint: 'rose' });
    expect(agentPlant('Codex', { tint: 'rose' })).toMatchObject({ plant: 'opuntia', tint: 'rose' });
  });

  it('matches the canonical plantForClient for any client, never the assistant’s sprout', () => {
    for (const name of ['Claude Code', 'Claude Desktop', 'codex-cli', 'Windsurf', 'Zed', 'My Script', '', null]) {
      const { plant, tint } = agentPlant(name);
      expect({ plant, tint }, String(name)).toEqual(plantForClient(name));
      expect(plant).not.toBe('sprout');
    }
  });
});
