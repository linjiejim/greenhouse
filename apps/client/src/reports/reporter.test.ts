import { describe, expect, it, vi } from 'vitest';
import type { ClientReport } from '../shared/client-reports';
import { createReporter, type ReportStorage } from './reporter';
import type { ReportContext } from './model';

function memoryStorage(initial: { queue?: string; mark?: string } = {}) {
  const data = { queue: initial.queue ?? null, mark: initial.mark ?? null } as { queue: string | null; mark: string | null };
  const storage: ReportStorage = {
    readQueue: () => data.queue,
    writeQueue: (text) => void (data.queue = text),
    readMark: () => data.mark,
    writeMark: (text) => void (data.mark = text),
  };
  return { storage, data };
}

const context = (station: string | null = 'st-home'): ReportContext => ({
  route: '/sheet/doc',
  station,
  platform: 'ios',
  os_version: '26.1',
  app_version: '4.0.0',
  app_build: '41',
  api_level: 4,
});

function setup(options: { status?: number; queue?: string; mark?: string } = {}) {
  let now = Date.parse('2026-10-29T10:00:00Z');
  let station: string | null = 'st-home';
  const { storage, data } = memoryStorage(options);
  const sent: { reports: ClientReport[]; station: string | null }[] = [];
  const send = vi.fn(async (reports: ClientReport[], to: string | null) => {
    sent.push({ reports, station: to });
    return options.status ?? 202;
  });
  const reporter = createReporter({ storage, context: () => context(station), send, now: () => now });
  return {
    reporter,
    data,
    sent,
    send,
    tick: (ms: number) => void (now += ms),
    atStation: (next: string | null) => void (station = next),
  };
}

describe('the reporter', () => {
  it('writes a report to storage before it returns, so a fatal error survives the abort', () => {
    const { reporter, data } = setup();
    const report = reporter.record(new Error('fatal frame'), { fatal: true, source: 'global' });
    expect(report).not.toBeNull();
    const saved = JSON.parse(data.queue!);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ message: 'fatal frame', fatal: true, station: 'st-home' });
  });

  it('reads what an earlier launch left and sends it, removing only what the station took', async () => {
    const first = setup();
    first.reporter.record(new Error('one'), { fatal: false, source: 'global' });
    first.reporter.record(new Error('two'), { fatal: true, source: 'global' });

    const next = setup({ queue: first.data.queue! });
    expect(next.reporter.pending()).toHaveLength(2);
    expect(await next.reporter.flush('st-home')).toBe(2);
    expect(next.sent).toHaveLength(1);
    expect(next.sent[0]!.station).toBe('st-home');
    expect(next.sent[0]!.reports.map((r) => r.message)).toEqual(['one', 'two']);
    expect(next.sent[0]!.reports[0]).not.toHaveProperty('station');
    expect(JSON.parse(next.data.queue!)).toEqual([]);
  });

  it('keeps reports when the station is unreachable or busy, and drops a batch it refuses as malformed', async () => {
    for (const status of [0, 429, 503]) {
      const t = setup({ status });
      t.reporter.record(new Error('kept'), { fatal: false, source: 'promise' });
      expect(await t.reporter.flush('st-home')).toBe(0);
      expect(t.reporter.pending()).toHaveLength(1);
    }
    const refused = setup({ status: 400 });
    refused.reporter.record(new Error('bad'), { fatal: false, source: 'promise' });
    expect(await refused.reporter.flush('st-home')).toBe(0);
    expect(refused.reporter.pending()).toHaveLength(0);
  });

  it('sends in batches of twenty and leaves another station its own', async () => {
    const t = setup();
    t.atStation('st-work');
    t.reporter.record(new Error('at work'), { fatal: false, source: 'global' });
    t.atStation('st-home');
    for (let i = 0; i < 25; i++) {
      t.tick(61_000);
      t.reporter.record(new Error(`home ${i}`), { fatal: false, source: 'global' });
    }
    expect(await t.reporter.flush('st-home')).toBe(25);
    expect(t.sent.map((s) => s.reports.length)).toEqual([20, 5]);
    expect(t.reporter.pending().map((r) => r.message)).toEqual(['at work']);
  });

  it('runs one flush at a time', async () => {
    const t = setup();
    t.reporter.record(new Error('once'), { fatal: false, source: 'global' });
    const [a, b] = await Promise.all([t.reporter.flush('st-home'), t.reporter.flush('st-home')]);
    expect(a + b).toBe(1);
    expect(t.send).toHaveBeenCalledTimes(1);
  });

  it('never throws, even when storage does', () => {
    const reporter = createReporter({
      storage: {
        readQueue: () => {
          throw new Error('disk');
        },
        writeQueue: () => {
          throw new Error('disk');
        },
        readMark: () => null,
        writeMark: () => undefined,
      },
      context: () => context(),
      send: async () => 202,
    });
    expect(() => reporter.record(new Error('x'), { fatal: true, source: 'global' })).not.toThrow();
  });

  it('turns a launch that ended in the foreground into an unclean-exit report, and a background end into nothing', () => {
    const crashed = setup();
    crashed.reporter.beginSession(true);
    crashed.reporter.markSession({ route: '/doc-new' });
    const after = setup({ mark: crashed.data.mark! });
    const unclean = after.reporter.beginSession(true);
    expect(unclean).toMatchObject({ source: 'unclean_exit', fatal: true, route: '/doc-new' });
    expect(after.reporter.pending()).toHaveLength(1);

    const backgrounded = setup();
    backgrounded.reporter.beginSession(true);
    backgrounded.reporter.markSession({ active: false });
    expect(setup({ mark: backgrounded.data.mark! }).reporter.beginSession(true)).toBeNull();
  });

  it('does not report an unclean exit for a crash it already reported', () => {
    const t = setup();
    t.reporter.beginSession(true);
    t.reporter.record(new Error('fatal'), { fatal: true, source: 'global' });
    const next = setup({ mark: t.data.mark!, queue: t.data.queue! });
    expect(next.reporter.beginSession(true)).toBeNull();
    expect(next.reporter.pending()).toHaveLength(1);
  });
});
