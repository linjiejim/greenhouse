/**
 * Tests for DSML interceptor — validates DSML detection, parsing,
 * stream transformation, and finishReason rewriting.
 */

import { describe, it, expect, vi } from 'vitest';
import { createDsmlInterceptor, type DsmlRecoveryEvent } from '@greenhouse/agent-core';

// ── Helpers ──────────────────────────────────────────────

/**
 * Simulate a stream of AI SDK model events through the DSML interceptor middleware.
 * Returns the output events after transformation.
 */
async function runInterceptor(
  inputParts: Array<Record<string, unknown>>,
  onRecovered?: (event: DsmlRecoveryEvent) => void,
  params: Record<string, unknown> = {},
): Promise<Array<Record<string, unknown>>> {
  const middleware = createDsmlInterceptor(onRecovered);

  // Create a readable stream from input parts
  const inputStream = new ReadableStream({
    start(controller) {
      for (const part of inputParts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });

  // Call wrapStream
  const result = await middleware.wrapStream!({
    doStream: async () => ({
      stream: inputStream,
    }),
    doGenerate: async () => ({}) as any,
    params: params as any,
    model: {} as any,
  });

  // Collect output events
  const output: Array<Record<string, unknown>> = [];
  const reader = result.stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    output.push(value as Record<string, unknown>);
  }
  return output;
}

// ── Tests ────────────────────────────────────────────────

describe('DSML Interceptor', () => {
  // ── Pass-through tests ──

  it('passes through normal text without DSML', async () => {
    const input = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'txt-0' },
      { type: 'text-delta', id: 'txt-0', delta: 'Hello, how can I help you today?' },
      { type: 'text-delta', id: 'txt-0', delta: ' I can assist with your plants.' },
      { type: 'text-end', id: 'txt-0' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: {} },
    ];

    const output = await runInterceptor(input);

    // All events pass through unchanged
    expect(output).toHaveLength(6);
    expect(output[0]).toEqual({ type: 'stream-start', warnings: [] });
    expect(output[1]).toEqual({ type: 'text-start', id: 'txt-0' });
    expect(output[2]).toEqual({ type: 'text-delta', id: 'txt-0', delta: 'Hello, how can I help you today?' });
    expect(output[3]).toEqual({ type: 'text-delta', id: 'txt-0', delta: ' I can assist with your plants.' });
    expect(output[4]).toEqual({ type: 'text-end', id: 'txt-0' });
    expect(output[5].type).toBe('finish');
  });

  it('passes through proper tool calls without interference', async () => {
    const input = [
      { type: 'stream-start', warnings: [] },
      { type: 'tool-input-start', id: 'call_123', toolName: 'search_team_knowledge' },
      { type: 'tool-input-delta', id: 'call_123', delta: '{"query":"basil"}' },
      { type: 'tool-input-end', id: 'call_123' },
      { type: 'tool-call', toolCallId: 'call_123', toolName: 'search_team_knowledge', input: '{"query":"basil"}' },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: {} },
    ];

    const output = await runInterceptor(input);

    expect(output).toHaveLength(6);
    expect(output[4]).toEqual({
      type: 'tool-call',
      toolCallId: 'call_123',
      toolName: 'search_team_knowledge',
      input: '{"query":"basil"}',
    });
    expect((output[5] as any).finishReason.unified).toBe('tool-calls');
  });

  // ── DSML recovery tests ──

  it('recovers DSML tool calls from text-delta (official format)', async () => {
    const dsmlBlock =
      '<｜DSML｜tool_calls>\n' +
      '<｜DSML｜invoke name="search_team_knowledge">\n' +
      '<｜DSML｜parameter name="query" string="true">basil growing guide</｜DSML｜parameter>\n' +
      '<｜DSML｜parameter name="limit" string="false">5</｜DSML｜parameter>\n' +
      '</｜DSML｜invoke>\n' +
      '</｜DSML｜tool_calls>';

    const input = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'txt-0' },
      { type: 'text-delta', id: 'txt-0', delta: 'Let me search for that.\n\n' + dsmlBlock },
      { type: 'text-end', id: 'txt-0' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: {} },
    ];

    const onRecovered = vi.fn();
    const output = await runInterceptor(input, onRecovered);

    // Should have text for "Let me search for that.\n\n"
    const textDeltas = output.filter((p) => p.type === 'text-delta');
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    const combinedText = textDeltas.map((p) => p.delta).join('');
    expect(combinedText).toBe('Let me search for that.\n\n');

    // Should have recovered tool call events
    // Legacy split name search_team_knowledge is aliased to the unified tool.
    const toolInputStarts = output.filter((p) => p.type === 'tool-input-start');
    expect(toolInputStarts).toHaveLength(1);
    expect(toolInputStarts[0].toolName).toBe('knowledge_query');

    const toolCalls = output.filter((p) => p.type === 'tool-call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].toolName).toBe('knowledge_query');
    const parsed = JSON.parse(toolCalls[0].input as string);
    expect(parsed.action).toBe('search');
    expect(parsed.query).toBe('basil growing guide');
    expect(parsed.limit).toBe(5);

    // finishReason should be rewritten
    const finish = output.find((p) => p.type === 'finish');
    expect((finish as any).finishReason.unified).toBe('tool-calls');

    // Callback should have been called
    expect(onRecovered).toHaveBeenCalledTimes(1);
    expect(onRecovered.mock.calls[0][0].toolCalls[0].name).toBe('knowledge_query');
  });

  it('recovers DSML with double full-width bars variant', async () => {
    const dsmlBlock =
      '<｜｜DSML｜｜tool_calls>\n' +
      '<｜｜DSML｜｜invoke name="get_team_knowledge">\n' +
      '<｜｜DSML｜｜parameter name="slug" string="true">product/lph-max</｜｜DSML｜｜parameter>\n' +
      '</｜｜DSML｜｜invoke>\n' +
      '</｜｜DSML｜｜tool_calls>';

    const input = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'txt-0' },
      { type: 'text-delta', id: 'txt-0', delta: dsmlBlock },
      { type: 'text-end', id: 'txt-0' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: {} },
    ];

    const output = await runInterceptor(input);

    const toolCalls = output.filter((p) => p.type === 'tool-call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].toolName).toBe('knowledge_query');

    const parsed = JSON.parse(toolCalls[0].input as string);
    expect(parsed.action).toBe('get');
    expect(parsed.slug).toBe('product/lph-max');
  });

  it('recovers DSML with ASCII pipes (rendering variant)', async () => {
    const dsmlBlock =
      '<|DSML|tool_calls>\n' +
      '<|DSML|invoke name="search_team_knowledge">\n' +
      '<|DSML|parameter name="query" string="true">battery level</|DSML|parameter>\n' +
      '</|DSML|invoke>\n' +
      '</|DSML|tool_calls>';

    const input = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'txt-0' },
      { type: 'text-delta', id: 'txt-0', delta: dsmlBlock },
      { type: 'text-end', id: 'txt-0' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: {} },
    ];

    const output = await runInterceptor(input);

    const toolCalls = output.filter((p) => p.type === 'tool-call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].toolName).toBe('knowledge_query');
  });

  it('handles DSML split across multiple text-delta chunks', async () => {
    const input = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'txt-0' },
      { type: 'text-delta', id: 'txt-0', delta: 'Let me check.\n\n<｜DSML｜tool_calls>\n<｜DSML｜invoke name="search' },
      { type: 'text-delta', id: 'txt-0', delta: '_team_knowledge">\n<｜DSML｜parameter name="query" string="true">' },
      {
        type: 'text-delta',
        id: 'txt-0',
        delta: 'WiFi setup</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>',
      },
      { type: 'text-end', id: 'txt-0' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: {} },
    ];

    const output = await runInterceptor(input);

    const toolCalls = output.filter((p) => p.type === 'tool-call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].toolName).toBe('knowledge_query');

    const parsed = JSON.parse(toolCalls[0].input as string);
    expect(parsed.query).toBe('WiFi setup');

    // finishReason should be rewritten
    const finish = output.find((p) => p.type === 'finish');
    expect((finish as any).finishReason.unified).toBe('tool-calls');
  });

  it('recovers DSML when the START marker itself is split token-by-token (real DeepSeek streaming)', async () => {
    // Regression (e2e 2026-06-24): DeepSeek streams the marker token-by-token
    // (`<` · `｜｜DSML｜｜` · `tool_calls>`), so the buffer transiently holds a
    // partial start like `<｜｜DSML｜｜`. The old checkBufferComplete treated that
    // as a false alarm and flushed it as text → raw DSML leaked into the answer
    // and no tool call was recovered. The end marker is split the same way.
    const input = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'txt-0' },
      { type: 'text-delta', id: 'txt-0', delta: '<' },
      { type: 'text-delta', id: 'txt-0', delta: '｜｜DSML｜｜' },
      { type: 'text-delta', id: 'txt-0', delta: 'tool_calls>' },
      { type: 'text-delta', id: 'txt-0', delta: '\n<｜｜DSML｜｜invoke name="get_team_knowledge">\n' },
      {
        type: 'text-delta',
        id: 'txt-0',
        delta: '<｜｜DSML｜｜parameter name="slug" string="true">product/lph-max',
      },
      { type: 'text-delta', id: 'txt-0', delta: '</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n' },
      { type: 'text-delta', id: 'txt-0', delta: '</' },
      { type: 'text-delta', id: 'txt-0', delta: '｜｜DSML｜｜' },
      { type: 'text-delta', id: 'txt-0', delta: 'tool_calls>' },
      { type: 'text-end', id: 'txt-0' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: {} },
    ];

    const recovered: DsmlRecoveryEvent[] = [];
    const output = await runInterceptor(input, (e) => recovered.push(e));

    // No DSML markup leaks into any forwarded text-delta.
    const leakedText = output
      .filter((p) => p.type === 'text-delta')
      .map((p) => p.delta as string)
      .join('');
    expect(leakedText).not.toContain('DSML');
    expect(leakedText).not.toContain('tool_calls');

    // The tool call was recovered and finishReason fixed to tool-calls.
    const toolCalls = output.filter((p) => p.type === 'tool-call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].toolName).toBe('knowledge_query');
    expect(JSON.parse(toolCalls[0].input as string)).toEqual({ action: 'get', slug: 'product/lph-max' });
    const finish = output.find((p) => p.type === 'finish');
    expect((finish as any).finishReason.unified).toBe('tool-calls');
    expect(recovered).toHaveLength(1);
  });

  it('handles multiple tool calls in one DSML block', async () => {
    const dsmlBlock =
      '<｜DSML｜tool_calls>\n' +
      '<｜DSML｜invoke name="search_team_knowledge">\n' +
      '<｜DSML｜parameter name="query" string="true">basil</｜DSML｜parameter>\n' +
      '</｜DSML｜invoke>\n' +
      '<｜DSML｜invoke name="search_team_knowledge">\n' +
      '<｜DSML｜parameter name="query" string="true">tomato</｜DSML｜parameter>\n' +
      '</｜DSML｜invoke>\n' +
      '</｜DSML｜tool_calls>';

    const input = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'txt-0' },
      { type: 'text-delta', id: 'txt-0', delta: dsmlBlock },
      { type: 'text-end', id: 'txt-0' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: {} },
    ];

    const output = await runInterceptor(input);

    const toolCalls = output.filter((p) => p.type === 'tool-call');
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].toolName).toBe('knowledge_query');
    expect(toolCalls[1].toolName).toBe('knowledge_query');
    expect(JSON.parse(toolCalls[0].input as string).query).toBe('basil');
    expect(JSON.parse(toolCalls[1].input as string).query).toBe('tomato');
  });

  // ── Edge cases ──

  it('de-dupes a recovered DSML call that is identical to a proper tool call', async () => {
    // Leaked DSML duplicates a call the API already parsed (same tool+args after
    // aliasing) — only the proper one should be emitted, not a duplicate.
    const dsmlBlock =
      '<｜DSML｜tool_calls>\n' +
      '<｜DSML｜invoke name="search_team_knowledge">\n' +
      '<｜DSML｜parameter name="query" string="true">basil</｜DSML｜parameter>\n' +
      '</｜DSML｜invoke>\n' +
      '</｜DSML｜tool_calls>';

    // Proper call matches the recovered call's normalized form exactly.
    const properInput = '{"action":"search","query":"basil"}';
    const input = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'txt-0' },
      { type: 'text-delta', id: 'txt-0', delta: dsmlBlock },
      { type: 'text-end', id: 'txt-0' },
      { type: 'tool-input-start', id: 'call_real', toolName: 'knowledge_query' },
      { type: 'tool-input-delta', id: 'call_real', delta: properInput },
      { type: 'tool-input-end', id: 'call_real' },
      { type: 'tool-call', toolCallId: 'call_real', toolName: 'knowledge_query', input: properInput },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: {} },
    ];

    const onRecovered = vi.fn();
    const output = await runInterceptor(input, onRecovered);

    const toolCalls = output.filter((p) => p.type === 'tool-call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].toolCallId).toBe('call_real');

    const finish = output.find((p) => p.type === 'finish');
    expect((finish as any).finishReason.unified).toBe('tool-calls');
    expect(onRecovered).not.toHaveBeenCalled();
  });

  it('still recovers a leaked DSML call that differs from the proper tool call', async () => {
    // The model emitted a proper call AND leaked a *different* DSML call as text.
    // The old behaviour silently dropped the leaked one; now it is recovered too.
    const dsmlBlock =
      '<｜DSML｜tool_calls>\n' +
      '<｜DSML｜invoke name="get_team_knowledge">\n' +
      '<｜DSML｜parameter name="slug" string="true">product/lph-se</｜DSML｜parameter>\n' +
      '</｜DSML｜invoke>\n' +
      '</｜DSML｜tool_calls>';

    const input = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'txt-0' },
      { type: 'text-delta', id: 'txt-0', delta: dsmlBlock },
      { type: 'text-end', id: 'txt-0' },
      {
        type: 'tool-call',
        toolCallId: 'call_real',
        toolName: 'knowledge_query',
        input: '{"action":"search","query":"basil"}',
      },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: {} },
    ];

    const output = await runInterceptor(input);

    const toolCalls = output.filter((p) => p.type === 'tool-call');
    expect(toolCalls).toHaveLength(2);
    const recovered = toolCalls.find((t) => t.toolCallId !== 'call_real');
    expect(recovered.toolName).toBe('knowledge_query');
    expect(JSON.parse(recovered.input as string)).toEqual({ action: 'get', slug: 'product/lph-se' });
  });

  it('handles text with < characters that are not DSML', async () => {
    const input = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'txt-0' },
      { type: 'text-delta', id: 'txt-0', delta: 'The temperature should be < 25°C for optimal growth.' },
      { type: 'text-end', id: 'txt-0' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: {} },
    ];

    const output = await runInterceptor(input);

    const textDeltas = output.filter((p) => p.type === 'text-delta');
    const combined = textDeltas.map((p) => p.delta).join('');
    expect(combined).toBe('The temperature should be < 25°C for optimal growth.');
  });

  // ── toolChoice-aware recovery (final-answer safeguard) ──

  it('does NOT recover DSML into tool-calls when tools are disabled (toolChoice none)', async () => {
    // The agent loop forces toolChoice:'none' on the final step so the model
    // answers in text. A DSML leak there must NOT be recovered into a tool call
    // — recovering rewrites finishReason to 'tool-calls' and strands the turn
    // with no answer (the v1 streaming "0 content" bug). It's stripped instead.
    const dsmlBlock =
      '<｜｜DSML｜｜tool_calls>\n' +
      '<｜｜DSML｜｜invoke name="get_team_knowledge">\n' +
      '<｜｜DSML｜｜parameter name="slug" string="true">product/lph-max</｜｜DSML｜｜parameter>\n' +
      '</｜｜DSML｜｜invoke>\n' +
      '</｜｜DSML｜｜tool_calls>';
    const input = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'txt-0' },
      { type: 'text-delta', id: 'txt-0', delta: dsmlBlock },
      { type: 'text-end', id: 'txt-0' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: {} },
    ];

    const onRecovered = vi.fn();
    const output = await runInterceptor(input, onRecovered, { toolChoice: { type: 'none' } });

    // No tool call recovered; finishReason left as 'stop'; callback not fired.
    expect(output.filter((p) => p.type === 'tool-call')).toHaveLength(0);
    expect(output.filter((p) => p.type === 'tool-input-start')).toHaveLength(0);
    expect((output.find((p) => p.type === 'finish') as any).finishReason.unified).toBe('stop');
    expect(onRecovered).not.toHaveBeenCalled();

    // The raw DSML markup is still stripped — never forwarded as text.
    const leaked = output
      .filter((p) => p.type === 'text-delta')
      .map((p) => p.delta as string)
      .join('');
    expect(leaked).not.toContain('DSML');
  });

  it('still recovers DSML when tools are enabled (toolChoice auto) — control', async () => {
    const dsmlBlock =
      '<｜｜DSML｜｜tool_calls>\n' +
      '<｜｜DSML｜｜invoke name="get_team_knowledge">\n' +
      '<｜｜DSML｜｜parameter name="slug" string="true">product/lph-max</｜｜DSML｜｜parameter>\n' +
      '</｜｜DSML｜｜invoke>\n' +
      '</｜｜DSML｜｜tool_calls>';
    const input = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'txt-0' },
      { type: 'text-delta', id: 'txt-0', delta: dsmlBlock },
      { type: 'text-end', id: 'txt-0' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: {} },
    ];

    const output = await runInterceptor(input, undefined, { toolChoice: { type: 'auto' } });

    expect(output.filter((p) => p.type === 'tool-call')).toHaveLength(1);
    expect((output.find((p) => p.type === 'finish') as any).finishReason.unified).toBe('tool-calls');
  });

  it('does not interfere with reasoning events', async () => {
    const input = [
      { type: 'stream-start', warnings: [] },
      { type: 'reasoning-start', id: 'r-0' },
      { type: 'reasoning-delta', id: 'r-0', delta: 'Let me think about this...' },
      { type: 'reasoning-end', id: 'r-0' },
      { type: 'text-start', id: 'txt-0' },
      { type: 'text-delta', id: 'txt-0', delta: 'Here is my answer.' },
      { type: 'text-end', id: 'txt-0' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: {} },
    ];

    const output = await runInterceptor(input);

    const reasoningParts = output.filter((p) => (p.type as string).startsWith('reasoning'));
    expect(reasoningParts).toHaveLength(3);
  });
});
