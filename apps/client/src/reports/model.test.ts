import { describe, expect, it } from 'vitest';
import {
  QUEUE_MAX,
  QUEUE_MAX_AGE_MS,
  buildReport,
  enqueueReport,
  errorParts,
  nextBatch,
  parseMark,
  parseQueue,
  reportId,
  sendOutcome,
  settleReports,
  uncleanExitReport,
  wireReport,
  type QueuedReport,
  type ReportContext,
} from './model';
import { redactReportText } from '../shared/client-reports';

const NOW = Date.parse('2026-10-29T10:00:00Z');
const context: ReportContext = {
  route: '/sheet/doc?id=doc_01JABCDEFGHJKMNPQRSTVWXYZ0',
  station: 'st-home',
  platform: 'ios',
  os_version: '26.1',
  app_version: '4.0.0',
  app_build: '41 ota 1a2b3c4d',
  api_level: 4,
};

let seq = 0;
const report = (overrides: Partial<QueuedReport> = {}, at = NOW): QueuedReport => ({
  ...buildReport(new TypeError(`boom ${seq}`), { fatal: false, source: 'global' }, context, at, `cr_test_${seq++}`),
  ...overrides,
});

describe('a report of a caught error', () => {
  it('reads anything thrown', () => {
    const error = new RangeError('too far');
    expect(errorParts(error)).toMatchObject({ name: 'RangeError', message: 'too far' });
    expect(errorParts(error).stack).toContain('RangeError');
    expect(errorParts('plain words')).toEqual({ name: 'Error', message: 'plain words', stack: null });
    expect(errorParts(undefined)).toEqual({ name: 'Error', message: 'undefined', stack: null });
    expect(errorParts({ code: 7 })).toEqual({ name: 'NonError', message: '{"code":7}', stack: null });
    expect(errorParts({ name: 'WorkletError', message: 'frame' })).toMatchObject({ name: 'WorkletError', message: 'frame' });
  });

  it('carries the app facts, the route without its query and no credentials or content', () => {
    const error = new Error(
      'POST https://jim:pw@station.test/api/chat?session=cnv_1#x failed for wang@test.local with Bearer abc.def; ' +
        'refresh_token=r3fr3sh; JSON Parse error: "this is the paragraph the member was writing"; ' +
        `push ExponentPushToken[${'x'.repeat(40)}]; phone 13812345678`,
    );
    const built = buildReport(error, { fatal: true, source: 'global' }, context, NOW, 'cr_abcdefgh');
    expect(built).toMatchObject({
      id: 'cr_abcdefgh',
      occurred_at: '2026-10-29T10:00:00.000Z',
      fatal: true,
      source: 'global',
      name: 'Error',
      route: '/sheet/doc',
      platform: 'ios',
      os_version: '26.1',
      app_version: '4.0.0',
      app_build: '41 ota 1a2b3c4d',
      api_level: 4,
      station: 'st-home',
    });
    expect(built.message).toBe(
      'POST https://station.test/api/chat failed for [email] with Bearer [redacted]; refresh_token=[redacted]; ' +
        'JSON Parse error: "[text]"; push ExponentPushToken[[secret]]; phone [number]',
    );
    expect(built.stack).not.toContain('pw@');
    expect(wireReport(built)).not.toHaveProperty('station');
  });

  it('keeps short code names, bundle file names and object ids readable', () => {
    expect(redactReportText("Cannot read property 'title' of undefined. Did you mean 'name'?", 600)).toBe(
      "Cannot read property 'title' of undefined. Did you mean 'name'?",
    );
    const frame = `at flush (https://station.test/_expo/static/js/web/entry-${'a1'.repeat(16)}.js:2:300)`;
    expect(redactReportText(frame, 600)).toBe(frame);
    expect(redactReportText('doc_01JABCDEFGHJKMNPQRSTVWXYZ0 not found', 600)).toBe('doc_01JABCDEFGHJKMNPQRSTVWXYZ0 not found');
  });

  it('cuts long messages and stacks', () => {
    const built = buildReport(
      Object.assign(new Error('word '.repeat(1000)), {
        stack: Array.from({ length: 300 }, (_, i) => `    at frame${i} (index.bundle:1:${i})`).join('\n'),
      }),
      { fatal: false, source: 'boundary' },
      context,
      NOW,
    );
    expect(built.message.length).toBe(600);
    expect(built.message.endsWith('…')).toBe(true);
    expect(built.stack!.split('\n')).toHaveLength(40);
  });
});

describe('the report queue', () => {
  it('keeps one report of an error repeating at the same place, but every fatal one', () => {
    const first = report({ message: 'loop' });
    let queue = enqueueReport([], first, NOW);
    queue = enqueueReport(queue, report({ message: 'loop' }, NOW + 1000), NOW + 1000);
    expect(queue).toHaveLength(1);
    queue = enqueueReport(queue, report({ message: 'loop', fatal: true }, NOW + 2000), NOW + 2000);
    expect(queue).toHaveLength(2);
    // a minute later it counts again, and elsewhere it is another report
    queue = enqueueReport(queue, report({ message: 'loop' }, NOW + 63_000), NOW + 63_000);
    queue = enqueueReport(queue, report({ message: 'loop', route: '/chat' }, NOW + 63_500), NOW + 63_500);
    expect(queue).toHaveLength(4);
  });

  it('keeps the newest reports and forgets old ones', () => {
    let queue: QueuedReport[] = [];
    for (let i = 0; i < QUEUE_MAX + 5; i++) queue = enqueueReport(queue, report({}, NOW + i), NOW + i);
    expect(queue).toHaveLength(QUEUE_MAX);
    expect(queue[0]!.occurred_at).toBe(new Date(NOW + 5).toISOString());
    const later = NOW + QUEUE_MAX_AGE_MS + 1000;
    expect(enqueueReport(queue, report({}, later), later)).toHaveLength(1);
  });

  it('sends a station its own reports and those of no station, a batch at a time', () => {
    const mine = report();
    const elsewhere = report({ station: 'st-work' });
    const before = report({ station: null });
    const queue = [mine, elsewhere, before, ...Array.from({ length: 30 }, () => report())];
    const batch = nextBatch(queue, 'st-home', NOW);
    expect(batch).toHaveLength(20);
    expect(batch.slice(0, 2)).toEqual([mine, before]);
    expect(batch).not.toContainEqual(elsewhere);
    expect(settleReports(queue, batch.map((r) => r.id))).toHaveLength(queue.length - 20);
  });

  it('keeps a batch the station did not take, unless it will never take it', () => {
    expect(sendOutcome(202)).toBe('settle');
    expect(sendOutcome(400)).toBe('settle');
    expect(sendOutcome(413)).toBe('settle');
    expect(sendOutcome(403)).toBe('settle');
    for (const status of [0, 401, 404, 429, 500, 503]) expect(sendOutcome(status)).toBe('keep');
  });

  it('reads back only what is still a report', () => {
    const kept = report();
    expect(parseQueue(JSON.stringify([kept, { id: 1 }, null, 'x']))).toEqual([kept]);
    expect(parseQueue('{')).toEqual([]);
    expect(parseQueue(null)).toEqual([]);
  });

  it('makes distinct ids the station accepts', () => {
    const ids = new Set(Array.from({ length: 100 }, () => reportId(NOW)));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});

describe('the session mark', () => {
  const mark = { started_at: NOW - 60_000, seen_at: NOW - 5000, route: '/doc-new', station: 'st-home', active: true, reported: false };

  it('reports a launch that ended in the foreground with nothing caught, where and when it was last seen', () => {
    const unclean = uncleanExitReport(parseMark(JSON.stringify(mark)), context, 'cr_unclean_1');
    expect(unclean).toMatchObject({
      fatal: true,
      source: 'unclean_exit',
      name: 'UncleanExit',
      route: '/doc-new',
      station: 'st-home',
      occurred_at: new Date(NOW - 5000).toISOString(),
    });
  });

  it('says nothing after a normal end, a reported crash or no mark', () => {
    expect(uncleanExitReport({ ...mark, active: false }, context)).toBeNull();
    expect(uncleanExitReport({ ...mark, reported: true }, context)).toBeNull();
    expect(uncleanExitReport(parseMark(null), context)).toBeNull();
    expect(parseMark('{"active":"yes"}')).toBeNull();
  });
});
