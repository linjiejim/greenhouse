/**
 * The fixed greeting never promises what the deployment cannot do: a
 * computer-bound template on an org without Bot computers opens with what it
 * can do here, not "on your computer".
 */

import { describe, expect, it } from 'vitest';
import type { ComputerRuntimeView } from '@greenhouse/types/bots';
import { buildGreeting, type GreetingFacts } from '../greeting.js';

function facts(locale: 'en' | 'zh', state: ComputerRuntimeView['state']): GreetingFacts {
  return {
    locale,
    computer: { state } as ComputerRuntimeView,
    vault: false,
    backgroundTasks: true,
    memory: { enabled: true, count: 0 },
  };
}

describe('buildGreeting', () => {
  for (const key of ['researcher', 'operator', 'analyst']) {
    it(`${key}: no computer → no "on your computer" promise`, () => {
      const bot = { name: 'Sage', role: 'Researcher', template_key: key };
      for (const state of ['disabled', 'unavailable', 'checking'] as const) {
        expect(buildGreeting(bot, facts('en', state))).not.toMatch(/on your computer|with Python on your computer/);
        expect(buildGreeting(bot, facts('zh', state))).not.toContain('在你的电脑上');
      }
    });
  }

  it('keeps the full pitch where the computer is ready', () => {
    const text = buildGreeting({ name: 'Sage', role: 'Researcher', template_key: 'researcher' }, facts('en', 'ready'));
    expect(text).toContain('Searches the web on your computer');
  });

  it('a template that needs no computer keeps its pitch either way', () => {
    const text = buildGreeting({ name: 'Fern', role: 'Writer', template_key: 'writer' }, facts('en', 'disabled'));
    expect(text).toContain('Drafts and polishes documents');
  });
});
