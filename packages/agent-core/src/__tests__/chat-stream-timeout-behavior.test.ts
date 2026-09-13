import { describe, expect, it } from 'vitest';
import { streamText } from 'ai';
import type { LanguageModelV3, LanguageModelV3StreamPart } from '@ai-sdk/provider';

function createIdleAfterPartialTextModel(): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'timeout-test',
    modelId: 'idle-after-partial-text',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('not used');
    },
    async doStream(options) {
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: 'text-1' });
          controller.enqueue({
            type: 'text-delta',
            id: 'text-1',
            delta: '```datatable\n{"columns":[{"key":"name"',
          });
          options.abortSignal?.addEventListener(
            'abort',
            () => controller.error(options.abortSignal?.reason ?? new Error('aborted')),
            { once: true },
          );
        },
      });
      return { stream };
    },
  };
}

describe('AI SDK idle-chunk timeout behavior', () => {
  it('turns the original partial-datatable stall into a bounded error finish', async () => {
    const result = streamText({
      model: createIdleAfterPartialTextModel(),
      prompt: 'list top 10 customers',
      timeout: { totalMs: 500, stepMs: 500, chunkMs: 20 },
    });
    const parts: Array<{ type: string; text?: string }> = [];

    for await (const part of result.fullStream) {
      parts.push({
        type: part.type,
        ...(part.type === 'text-delta' ? { text: part.text } : {}),
      });
    }

    expect(parts).toContainEqual({
      type: 'text-delta',
      text: '```datatable\n{"columns":[{"key":"name"',
    });
    expect(parts).toContainEqual({ type: 'abort' });
    await expect(result.finishReason).rejects.toThrow();
  });
});
