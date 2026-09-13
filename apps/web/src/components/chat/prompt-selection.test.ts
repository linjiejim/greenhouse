import { describe, expect, it } from 'vitest';
import type { UserPrompt } from '@greenhouse/types/api';
import { composePromptMessage } from './prompt-selection';

const base = {
  id: 1,
  user_id: 'user-1',
  title: 'Market research',
  content: 'Research the supplied market in depth.',
  shortcut: 'market-research',
  sort_order: 0,
  is_global: false,
  description: null,
  variables: '[]',
  expected_tools: '[]',
  source_session_id: null,
  created_via: 'manual',
  created_at: '2026-08-07T00:00:00.000Z',
  updated_at: '2026-08-07T00:00:00.000Z',
} satisfies UserPrompt;

describe('structured task selection', () => {
  it('keeps the visible draft separate and expands the task only when sending', () => {
    expect(composePromptMessage('Focus on smart gardens.', base)).toBe(
      'Research the supplied market in depth.\n\nFocus on smart gardens.',
    );
  });

  it('can send a selected task without additional visible text', () => {
    expect(composePromptMessage('', base)).toBe('Research the supplied market in depth.');
  });

  it('substitutes filled variables into the body', () => {
    const task = { ...base, content: 'Summarise {{month}} sales for {{region}}.' } satisfies UserPrompt;
    expect(composePromptMessage('', task, { month: 'July', region: 'EU' })).toBe('Summarise July sales for EU.');
  });

  it('leaves an unfilled placeholder visible rather than blanking it', () => {
    // A silent gap would change what the task asks for; a visible {{region}}
    // is something the model is told to ask about.
    const task = { ...base, content: 'Summarise {{month}} sales for {{region}}.' } satisfies UserPrompt;
    expect(composePromptMessage('', task, { month: 'July' })).toBe('Summarise July sales for {{region}}.');
    expect(composePromptMessage('', task, { month: 'July', region: '   ' })).toBe(
      'Summarise July sales for {{region}}.',
    );
  });
});
