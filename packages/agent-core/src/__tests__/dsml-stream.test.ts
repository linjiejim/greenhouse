/**
 * The DSML interceptor on a real stream (streamText + wrapLanguageModel over a
 * V4 mock), token-split the way DeepSeek streams it. The parser tests cover
 * the block grammar; these pin what reaches the user and the loop:
 *   - a normal step recovers the leaked call into a real tool call;
 *   - a forced text-only step (toolChoice 'none') strips it without recovery;
 *   - the `<｜｜DSML｜｜ calls>` wrapper variant observed on 2026-10-09 is caught
 *     too (it used to reach the user as raw markup).
 */

import { simulateReadableStream, streamText, wrapLanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { createDsmlInterceptor } from '../dsml-interceptor.js';

const B = '｜';

function leak(wrapper: string): string {
  return (
    `<${B}${B}DSML${B}${B}${wrapper}>\n` +
    `<${B}${B}DSML${B}${B} invoke name="fetch_report">\n` +
    `<${B}${B}DSML${B}${B} parameter name="n" string="false">4</${B}${B}DSML${B}${B} parameter>\n` +
    `</${B}${B}DSML${B}${B} invoke>\n` +
    `</${B}${B}DSML${B}${B}${wrapper}>`
  );
}

/** Split into small deltas, as the provider streams tokens. */
function chunksFor(text: string) {
  const deltas: string[] = [];
  for (let i = 0; i < text.length; i += 7) deltas.push(text.slice(i, i + 7));
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    ...deltas.map((delta) => ({ type: 'text-delta', id: 't', delta })),
    { type: 'text-end', id: 't' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      },
    },
  ];
}

async function run(text: string, toolChoice: 'auto' | 'none') {
  const model = wrapLanguageModel({
    model: new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: chunksFor(text) as never[] }) }),
    }),
    middleware: createDsmlInterceptor(),
  });
  const result = streamText({ model, prompt: 'go', toolChoice, maxRetries: 0 });
  let out = '';
  const calls: Array<{ toolName: string; input: unknown }> = [];
  for await (const part of result.stream) {
    if (part.type === 'text-delta') out += part.text;
    if (part.type === 'tool-call') calls.push({ toolName: part.toolName, input: part.input });
  }
  return { text: out, calls };
}

describe('DSML interceptor on a stream', () => {
  for (const wrapper of ['tool_calls', ' calls']) {
    it(`recovers a leaked call on a normal step (<…DSML…${wrapper}>)`, async () => {
      const { text, calls } = await run(`Let me check.${leak(wrapper)}`, 'auto');
      expect(text).toBe('Let me check.');
      expect(calls).toEqual([{ toolName: 'fetch_report', input: { n: 4 } }]);
    });

    it(`strips it without recovery on a forced text-only step (<…DSML…${wrapper}>)`, async () => {
      const { text, calls } = await run(`Report 1 says APPLE.${leak(wrapper)}`, 'none');
      expect(text).toBe('Report 1 says APPLE.');
      expect(calls).toEqual([]);
    });
  }

  it('leaves ordinary angle brackets alone', async () => {
    const { text } = await run('if a < b then <b>bold</b> and x <| y', 'auto');
    expect(text).toBe('if a < b then <b>bold</b> and x <| y');
  });
});
