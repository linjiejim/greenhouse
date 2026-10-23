import { describe, expect, it } from 'vitest';
import { offlineView } from './offline-view';

const saved = { tasks: ['a'] };
const fresh = { tasks: ['a', 'b'] };

describe('a screen with an offline copy', () => {
  it('shows the saved copy at once while the station is asked', () => {
    expect(offlineView({ fresh: null, saved, loading: true, missStatus: null })).toEqual({ data: saved, offline: false, evict: false });
  });

  it('takes the station’s answer over the copy', () => {
    expect(offlineView({ fresh, saved, loading: false, missStatus: null })).toEqual({ data: fresh, offline: false, evict: false });
  });

  it('keeps the copy, marked offline, when the station cannot be reached', () => {
    for (const status of [0, 502, 503, 504]) {
      expect(offlineView({ fresh: null, saved, loading: false, missStatus: status })).toEqual({ data: saved, offline: true, evict: false });
    }
    expect(offlineView({ fresh: null, saved: null, loading: false, missStatus: 0 })).toEqual({ data: null, offline: false, evict: false });
  });

  it('deletes the copy when access was revoked or the thing is gone', () => {
    for (const status of [403, 404, 410]) {
      expect(offlineView({ fresh: null, saved, loading: false, missStatus: status })).toEqual({ data: null, offline: false, evict: true });
    }
  });

  it('deletes the copy on disk even when it was never read into memory', () => {
    // first open: the answer was saved to disk while the earlier disk read found nothing
    for (const status of [403, 404, 410]) {
      expect(offlineView({ fresh: null, saved: null, loading: false, missStatus: status })).toEqual({ data: null, offline: false, evict: true });
    }
  });

  it('shows another error instead of the copy', () => {
    expect(offlineView({ fresh: null, saved, loading: false, missStatus: 500 })).toEqual({ data: null, offline: false, evict: false });
  });
});
