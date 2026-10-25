import { describe, expect, it } from 'vitest';
import type { TFunction } from '../lib/i18n';
import { headerSubtitle } from './header-words';
import type { ToolStep } from './parts';

const t = ((key: string, vars?: Record<string, string | number>) => (vars ? `${key}${JSON.stringify(vars)}` : key)) as TFunction;
const step = (patch: Partial<ToolStep>): ToolStep => ({ id: 'p1', tool: 'knowledge_query', status: 'done', ...patch });

describe('headerSubtitle', () => {
  it('names the agent when nothing is being written', () => {
    expect(headerSubtitle('Sprouty', null, t)).toBe('Sprouty');
    expect(headerSubtitle('Sprouty', { busy: false, tool: null, steps: [step({})], hasText: true }, t)).toBe('Sprouty');
  });

  it('says what the reply is doing now', () => {
    expect(headerSubtitle('Sprouty', { busy: true, tool: null, steps: [], hasText: false }, t)).toBe('conversation.subThinking');
    expect(headerSubtitle('Sprouty', { busy: true, tool: 'web_search', steps: [], hasText: false }, t)).toBe('tools.doing.web_search');
    expect(headerSubtitle('Sprouty', { busy: true, tool: null, steps: [step({ status: 'running' })], hasText: true }, t)).toBe(
      'tools.doing.knowledge_query',
    );
    expect(headerSubtitle('Sprouty', { busy: true, tool: null, steps: [step({})], hasText: true }, t)).toBe('conversation.subWriting');
  });
});
