import { describe, it, expect } from 'vitest';
import { parseDsmlBlock } from '../dsml-interceptor.js';

// Full-width vertical bar U+FF5C, as DeepSeek emits it.
const B = '｜';
const dsml = (invokeName: string, params: string) =>
  `<${B}${B}DSML${B}${B}invoke name="${invokeName}">\n${params}\n</${B}${B}DSML${B}${B}invoke>`;
const param = (name: string, isStr: boolean, val: string) =>
  `<${B}${B}DSML${B}${B}parameter name="${name}" string="${isStr}">${val}</${B}${B}DSML${B}${B}parameter>`;

describe('parseDsmlBlock', () => {
  it('parses a leaked call with a string parameter', () => {
    const block = dsml('knowledge_query', param('id', true, 'doc_68cd26d32b3ac1aa25c09737'));
    expect(parseDsmlBlock(block)).toEqual([{ name: 'knowledge_query', args: { id: 'doc_68cd26d32b3ac1aa25c09737' } }]);
  });

  it('parses a numeric (non-string) parameter as JSON', () => {
    const block = dsml(
      'web_search',
      `${param('query', true, 'phone timer mode light schedule')}\n${param('limit', false, '10')}`,
    );
    expect(parseDsmlBlock(block)).toEqual([
      { name: 'web_search', args: { query: 'phone timer mode light schedule', limit: 10 } },
    ]);
  });
});
