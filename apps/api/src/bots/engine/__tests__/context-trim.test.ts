/**
 * In-turn trimming (design review R6): a long browsing turn stays bounded,
 * tool-call/result pairs survive, stubs only appear at batch points.
 */

import { describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import { estimateTokens } from '@greenhouse/agent-core';
import {
  compactObservationPipeline,
  createObservationTrimmer,
  IN_TURN_TOOL_TOKEN_BUDGET,
  observationStub,
} from '../context-trim.js';

/** A CJK page snapshot of ~3k estimated tokens. */
function snapshot(i: number) {
  return { action: 'snapshot', url: `https://example.cn/page/${i}`, title: `页面 ${i}`, snapshot: '内容'.repeat(1500) };
}

function toolRound(i: number): ModelMessage[] {
  return [
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: `c${i}`, toolName: 'browser', input: { action: 'snapshot' } }],
    },
    {
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: `c${i}`, toolName: 'browser', output: { type: 'json', value: snapshot(i) } },
      ],
    },
  ] as ModelMessage[];
}

function payloadTokens(messages: ModelMessage[]): number {
  return estimateTokens(JSON.stringify(messages));
}

describe('createObservationTrimmer', () => {
  it('keeps 30 CJK snapshots within budget and leaves call/result pairs intact', () => {
    const trim = createObservationTrimmer();
    let messages: ModelMessage[] = [{ role: 'user', content: '帮我查一下' }];
    let sent: ModelMessage[] = messages;
    for (let i = 0; i < 30; i += 1) {
      messages = [...messages, ...toolRound(i)];
      sent = trim({ stepNumber: i + 1, messages }) ?? messages;
    }
    // Untrimmed this would be ~90k tokens.
    expect(payloadTokens(messages)).toBeGreaterThan(80_000);
    expect(payloadTokens(sent)).toBeLessThan(IN_TURN_TOOL_TOKEN_BUDGET + 4_000);
    // Every call still has its result; only the snapshots since the last batch
    // point (at most a budget's worth) are whole, the newest always is.
    const results = sent.flatMap((m) =>
      m.role === 'tool' ? (m.content as Array<{ toolCallId: string; output: { type: string } }>) : [],
    );
    expect(results).toHaveLength(30);
    const whole = results.filter((r) => r.output.type === 'json').length;
    expect(whole).toBeGreaterThanOrEqual(1);
    expect(whole).toBeLessThanOrEqual(4);
    expect(results.at(-1)!.output.type).toBe('json');
  });

  it('does not rewrite anything below the budget (no prefix churn)', () => {
    const trim = createObservationTrimmer();
    const messages: ModelMessage[] = [{ role: 'user', content: 'hi' }, ...toolRound(1), ...toolRound(2)];
    expect(trim({ stepNumber: 2, messages })).toBeUndefined();
  });

  it('never un-stubs: a batch point only grows the stubbed set', () => {
    const trim = createObservationTrimmer(5_000);
    let messages: ModelMessage[] = [{ role: 'user', content: 'go' }];
    for (let i = 0; i < 3; i += 1) messages = [...messages, ...toolRound(i)];
    const first = trim({ stepNumber: 3, messages })!;
    messages = [...messages, ...toolRound(3)];
    const second = trim({ stepNumber: 4, messages })!;
    const stubbedIds = (list: ModelMessage[]) =>
      list
        .flatMap((m) =>
          m.role === 'tool' ? (m.content as Array<{ toolCallId: string; output: { type: string } }>) : [],
        )
        .filter((r) => r.output.type === 'text')
        .map((r) => r.toolCallId);
    expect(stubbedIds(second)).toEqual(expect.arrayContaining(stubbedIds(first)));
  });

  it('stubs carry the facts a Bot needs (≤300 chars)', () => {
    const stub = observationStub('browser', snapshot(7));
    expect(stub).toContain('url=https://example.cn/page/7');
    expect(stub).toContain('title=页面 7');
    expect(stub.length).toBeLessThanOrEqual(300);
  });
});

describe('compactObservationPipeline', () => {
  it('stores the action, not the page, for browser and computer steps', () => {
    const [step] = compactObservationPipeline([
      { step: 1, tool: 'browser', input: {}, output: snapshot(1), duration_ms: 5 },
    ]);
    expect(step!.output).toEqual({ action: 'snapshot', url: 'https://example.cn/page/1', title: '页面 1' });
    const [other] = compactObservationPipeline([
      { step: 1, tool: 'memory', input: {}, output: { a: 1 }, duration_ms: 1 },
    ]);
    expect(other!.output).toEqual({ a: 1 });
  });

  it('keeps a share_file attachment whole, so its download card survives persistence', () => {
    const attachment = {
      type: 'file',
      file_id: 'f1',
      name: 'chart.png',
      content_type: 'image/png',
      size: 10,
      download_url: '/api/chat-files/f1/content',
    };
    const [step] = compactObservationPipeline([
      {
        step: 1,
        tool: 'computer',
        input: { action: 'share_file', path: 'chart.png' },
        output: attachment,
        duration_ms: 1,
      },
    ]);
    expect(step!.output).toEqual(attachment);
    // A stubbed share_file result still names the file it shared.
    expect(observationStub('computer', attachment)).toContain('file_id=f1');
    expect(observationStub('computer', attachment)).toContain('name=chart.png');
  });

  it('keeps a browser screenshot whole too — it returns the same file-artifact shape', () => {
    const shot = {
      url: 'https://example.cn/report',
      title: '报表',
      snapshot: '',
      type: 'file',
      file_id: 'f2',
      name: 'screenshot.png',
      content_type: 'image/png',
      size: 2048,
      download_url: '/api/chat-files/f2/content',
      note: 'Screenshot saved.',
    };
    const [step] = compactObservationPipeline([
      { step: 1, tool: 'browser', input: { action: 'screenshot' }, output: shot, duration_ms: 3 },
    ]);
    expect(step!.output).toEqual(shot);
    // A file_id that is not a string is not an artifact: the page facts filter still applies.
    const [notFile] = compactObservationPipeline([
      { step: 1, tool: 'browser', input: {}, output: { ...snapshot(2), type: 'file' }, duration_ms: 3 },
    ]);
    expect(notFile!.output).toEqual({ url: 'https://example.cn/page/2', title: '页面 2', action: 'snapshot' });
  });
});
