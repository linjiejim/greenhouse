import { describe, expect, it } from 'vitest';
import { agentPlant, clientKindOf } from './agent-plant';

describe('a connected agent’s plant', () => {
  it('follows the client by default', () => {
    expect(agentPlant('claude-code', 'Claude Code · MacBook').plant).toBe('lavender');
    expect(agentPlant('codex', 'Codex').plant).toBe('opuntia');
    expect(agentPlant('cursor', 'Cursor').plant).toBe('ginkgo');
  });

  it('takes the plant the member chose', () => {
    expect(agentPlant('codex', 'Codex', { plant: 'fern', tint: 'rose' })).toMatchObject({ plant: 'fern', tint: 'rose' });
  });

  it('gives an unknown client a stable plant that is never the assistant’s sprout', () => {
    const first = agentPlant('other', 'My Script');
    expect(agentPlant('other', 'My Script').plant).toBe(first.plant);
    expect(first.plant).not.toBe('sprout');
  });

  it('guesses the client from a write’s client name', () => {
    expect(clientKindOf('Claude Code · MacBook')).toBe('claude-code');
    expect(clientKindOf('codex-cli')).toBe('codex');
    expect(clientKindOf('My script')).toBe('other');
  });
});
