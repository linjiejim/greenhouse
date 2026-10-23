import { describe, expect, it } from 'vitest';
import { LatestChoice } from './latest-choice';

/** A server whose saves settle when the test says so. */
function server(fail: (value: string) => boolean = () => false) {
  const sent: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const pending: (() => void)[] = [];
  const save = (value: string) =>
    new Promise<{ ok: true; data: string } | { ok: false; message: string }>((resolve) => {
      sent.push(value);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      pending.push(() => {
        inFlight -= 1;
        resolve(fail(value) ? { ok: false, message: `no ${value}` } : { ok: true, data: `saved ${value}` });
      });
    });
  const settle = async () => {
    pending.shift()?.();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { save, sent, settle, maxInFlight: () => maxInFlight };
}

describe('a menu choice saved one change at a time', () => {
  it('sends at most one change at a time and ends on the last choice', async () => {
    const s = server();
    const choice = new LatestChoice('todo', s.save);
    const a = choice.choose('in_progress');
    const b = choice.choose('in_review');
    const c = choice.choose('done');
    await s.settle();
    await s.settle();
    expect(s.sent).toEqual(['in_progress', 'done']);
    expect(s.maxInFlight()).toBe(1);
    expect(await a).toBeNull();
    expect(await b).toBeNull();
    expect(await c).toEqual({ ok: true, value: 'done', data: 'saved done' });
  });

  it('rolls the last choice back to what the server confirmed, even by a superseded save', async () => {
    const s = server((value) => value === 'cancelled');
    const choice = new LatestChoice('todo', s.save);
    const first = choice.choose('in_progress');
    const last = choice.choose('cancelled');
    await s.settle();
    await s.settle();
    expect(await first).toBeNull();
    expect(await last).toEqual({ ok: false, rollbackTo: 'in_progress', message: 'no cancelled' });
  });

  it('rolls back to the starting value when nothing was saved', async () => {
    const s = server(() => true);
    const choice = new LatestChoice('todo', s.save);
    const only = choice.choose('done');
    await s.settle();
    expect(await only).toEqual({ ok: false, rollbackTo: 'todo', message: 'no done' });
  });

  it('starts again after it went idle', async () => {
    const s = server();
    const choice = new LatestChoice('todo', s.save);
    const one = choice.choose('done');
    await s.settle();
    expect(await one).toMatchObject({ ok: true, value: 'done' });
    const two = choice.choose('todo');
    await s.settle();
    expect(await two).toMatchObject({ ok: true, value: 'todo' });
    expect(s.sent).toEqual(['done', 'todo']);
  });

  it('drops queued saves after a station or account switch and writes nothing more', async () => {
    const s = server();
    let current = true;
    const choice = new LatestChoice('todo', s.save, () => current);
    const first = choice.choose('in_progress');
    const queued = choice.choose('done');
    current = false; // switched while the first save was in flight
    await s.settle();
    await s.settle();
    expect(s.sent).toEqual(['in_progress']);
    expect(await first).toBeNull();
    expect(await queued).toBeNull();
    const later = choice.choose('cancelled');
    expect(await later).toBeNull();
    expect(s.sent).toEqual(['in_progress']);
  });

});
