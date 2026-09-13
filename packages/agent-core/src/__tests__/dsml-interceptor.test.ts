import { describe, it, expect } from 'vitest';
import { parseDsmlBlock, normalizeToolCall } from '../dsml-interceptor.js';

// Full-width vertical bar U+FF5C, as DeepSeek emits it.
const B = '｜';
const dsml = (invokeName: string, params: string) =>
  `<${B}${B}DSML${B}${B}invoke name="${invokeName}">\n${params}\n</${B}${B}DSML${B}${B}invoke>`;
const param = (name: string, isStr: boolean, val: string) =>
  `<${B}${B}DSML${B}${B}parameter name="${name}" string="${isStr}">${val}</${B}${B}DSML${B}${B}parameter>`;

describe('normalizeToolCall', () => {
  it('maps legacy get_team_knowledge → knowledge_query action=get', () => {
    expect(normalizeToolCall({ name: 'get_team_knowledge', args: { slug: 'product/lph-se' } })).toEqual({
      name: 'knowledge_query',
      args: { action: 'get', slug: 'product/lph-se' },
    });
  });

  it('maps legacy search_team_knowledge → knowledge_query action=search', () => {
    expect(normalizeToolCall({ name: 'search_team_knowledge', args: { query: 'basil' } })).toEqual({
      name: 'knowledge_query',
      args: { action: 'search', query: 'basil' },
    });
  });

  it('leaves unified tool names untouched', () => {
    const call = { name: 'knowledge_query', args: { action: 'get', slug: 'x' } };
    expect(normalizeToolCall(call)).toEqual(call);
    expect(normalizeToolCall({ name: 'compute', args: { fact: 'y' } })).toEqual({
      name: 'compute',
      args: { fact: 'y' },
    });
  });
});

describe('parseDsmlBlock', () => {
  it('parses a leaked get_team_knowledge block and aliases it', () => {
    const block = dsml('get_team_knowledge', param('slug', true, 'blog/68cd26d32b3ac1aa25c09737'));
    expect(parseDsmlBlock(block)).toEqual([
      { name: 'knowledge_query', args: { action: 'get', slug: 'blog/68cd26d32b3ac1aa25c09737' } },
    ]);
  });

  it('parses a leaked search_team_knowledge block with a numeric (non-string) param', () => {
    const block = dsml(
      'search_team_knowledge',
      `${param('query', true, 'phone timer mode light schedule')}\n${param('limit', false, '10')}`,
    );
    expect(parseDsmlBlock(block)).toEqual([
      { name: 'knowledge_query', args: { action: 'search', query: 'phone timer mode light schedule', limit: 10 } },
    ]);
  });
});
