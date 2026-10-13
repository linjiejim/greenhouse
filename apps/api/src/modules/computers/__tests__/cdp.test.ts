/** The DevTools pipe protocol over a computer's byte stream: framing, ids, events and endings. */

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { SandboxStream } from '@greenhouse/providers';
import { CdpError, frame, NulFramer, openCdp } from '../cdp.js';

function pipe() {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  let resolve!: (code: number | null) => void;
  const exited = new Promise<number | null>((done) => (resolve = done));
  const sent: Array<Record<string, unknown>> = [];
  const framer = new NulFramer();
  input.on('data', (chunk: Buffer) => {
    for (const message of framer.push(chunk)) sent.push(JSON.parse(message) as Record<string, unknown>);
  });
  let killed = false;
  const stream: SandboxStream = {
    input,
    output,
    errors,
    exited,
    kill: () => {
      killed = true;
      output.end();
      resolve(null);
    },
  };
  return {
    stream,
    sent,
    reply: (message: Record<string, unknown>) => output.write(frame(message)),
    exit: (code: number) => {
      output.end();
      resolve(code);
    },
    killed: () => killed,
    raw: (bytes: Buffer) => output.write(bytes),
    inputEnded: () => input.writableEnded,
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('NulFramer', () => {
  it('cuts messages at NUL bytes, across chunks, and keeps characters split between chunks whole', () => {
    const framer = new NulFramer();
    const bytes = Buffer.from('{"a":"你好"}\0{"b":2}\0{"c"', 'utf8');
    // Split inside the first Chinese character.
    const cut = bytes.indexOf(Buffer.from('你', 'utf8')) + 1;
    expect(framer.push(bytes.subarray(0, cut))).toEqual([]);
    expect(framer.push(bytes.subarray(cut))).toEqual(['{"a":"你好"}', '{"b":2}']);
    expect(framer.push(Buffer.from(':3}\0\0', 'utf8'))).toEqual(['{"c":3}']);
  });

  it('refuses a message larger than its limit, even before it ends', () => {
    const framer = new NulFramer(10);
    expect(() => framer.push(Buffer.from('0123456789ABC'))).toThrow(/too large/);
    expect(() => new NulFramer(10).push(Buffer.from('012345\0' + '0123456789ABCDEF\0'))).toThrow(/too large/);
  });

  it('frames JSON with the id first and no raw NUL inside', () => {
    const wire = frame({ id: 7, method: 'Input.insertText', params: { text: 'a\u0000b' } });
    expect(wire.indexOf(0)).toBe(wire.length - 1);
    expect(wire.toString('utf8').startsWith('{"id":7,')).toBe(true);
  });
});

describe('openCdp', () => {
  it('numbers commands from 1, answers each by its id, and routes session commands', async () => {
    const wire = pipe();
    const cdp = openCdp(wire.stream);
    const first = cdp.send('Target.getTargets');
    const second = cdp.send('Runtime.evaluate', { expression: '1' }, { sessionId: 'S1' });
    await tick();
    expect(wire.sent).toEqual([
      { id: 1, method: 'Target.getTargets', params: {} },
      { id: 2, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: 'S1' },
    ]);
    // Out of order, as the browser may answer.
    wire.reply({ id: 2, result: { result: { value: 1 } }, sessionId: 'S1' });
    wire.reply({ id: 1, result: { targetInfos: [] } });
    await expect(second).resolves.toEqual({ result: { value: 1 } });
    await expect(first).resolves.toEqual({ targetInfos: [] });
    cdp.close();
  });

  it("rejects with the browser's error, naming the method only", async () => {
    const wire = pipe();
    const cdp = openCdp(wire.stream);
    const failing = cdp.send('Input.insertText', { text: 'hunter2-secret' });
    await tick();
    wire.reply({ id: 1, error: { code: -32000, message: 'No node with given id found' } });
    const error = await failing.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CdpError);
    expect(error).toMatchObject({ method: 'Input.insertText', code: -32000, message: 'No node with given id found' });
    expect(String((error as Error).message)).not.toContain('hunter2');
    cdp.close();
  });

  it('hands events to listeners with their session, and ignores what is not JSON', async () => {
    const wire = pipe();
    const cdp = openCdp(wire.stream);
    const events: unknown[] = [];
    const stop = cdp.on((event) => events.push(event));
    wire.raw(Buffer.from('not json\0'));
    wire.reply({ method: 'Page.javascriptDialogOpening', params: { type: 'alert', message: 'hi' }, sessionId: 'S1' });
    await tick();
    stop();
    wire.reply({ method: 'Page.loadEventFired', params: {} });
    await tick();
    expect(events).toEqual([
      { method: 'Page.javascriptDialogOpening', params: { type: 'alert', message: 'hi' }, sessionId: 'S1' },
    ]);
    cdp.close();
  });

  it('fails what waits when the stream ends, and refuses to send afterwards', async () => {
    const wire = pipe();
    const cdp = openCdp(wire.stream);
    const waiting = cdp.send('Page.navigate', { url: 'https://example.com' });
    await tick();
    wire.exit(1);
    await expect(waiting).rejects.toThrow(/closed/);
    expect(cdp.closed).toBe(true);
    await expect(cdp.send('Target.getTargets')).rejects.toThrow(/closed/);
  });

  it('times out a command the browser never answers, and drops its late answer', async () => {
    const wire = pipe();
    const cdp = openCdp(wire.stream, { timeoutMs: 20 });
    await expect(cdp.send('Accessibility.getFullAXTree')).rejects.toThrow(/in time/);
    wire.reply({ id: 1, result: { nodes: [] } });
    const next = cdp.send('Target.getTargets');
    await tick();
    wire.reply({ id: 2, result: { targetInfos: [] } });
    await expect(next).resolves.toEqual({ targetInfos: [] });
    cdp.close();
  });

  it('stops on abort: pending commands fail, the tunnel input ends', async () => {
    const wire = pipe();
    const controller = new AbortController();
    const cdp = openCdp(wire.stream, { signal: controller.signal });
    const waiting = cdp.send('Runtime.evaluate', { expression: 'document.readyState' });
    controller.abort();
    await expect(waiting).rejects.toThrow(/Stopped/);
    expect(wire.inputEnded()).toBe(true);
  });

  it('closes on a message past the size limit', async () => {
    const wire = pipe();
    const cdp = openCdp(wire.stream, { maxMessageBytes: 16 });
    const waiting = cdp.send('Page.captureScreenshot');
    await tick();
    wire.reply({ id: 1, result: { data: 'x'.repeat(64) } });
    await expect(waiting).rejects.toThrow(/too large/);
    expect(cdp.closed).toBe(true);
  });
});
