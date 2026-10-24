import { describe, expect, it } from 'vitest';
import { offlineView } from './offline-view';

const saved = { tasks: ['a'] };
const fresh = { tasks: ['a', 'b'] };

describe('a screen with an offline copy', () => {
  it('shows the saved copy at once while the station is asked', () => {
    expect(offlineView({ fresh: null, saved, missStatus: null })).toEqual({ data: saved, offline: false, evict: false });
  });

  it('takes the station’s answer over the copy', () => {
    expect(offlineView({ fresh, saved, missStatus: null })).toEqual({ data: fresh, offline: false, evict: false });
  });

  it('keeps the copy, marked offline, when the station cannot be reached', () => {
    for (const status of [0, 502, 503, 504]) {
      expect(offlineView({ fresh: null, saved, missStatus: status })).toEqual({ data: saved, offline: true, evict: false });
    }
    expect(offlineView({ fresh: null, saved: null, missStatus: 0 })).toEqual({ data: null, offline: false, evict: false });
  });

  it('marks the earlier answer offline when a later refresh cannot reach the station', () => {
    for (const status of [0, 503]) {
      expect(offlineView({ fresh, saved: null, missStatus: status })).toEqual({ data: fresh, offline: true, evict: false });
      expect(offlineView({ fresh, saved, missStatus: status })).toEqual({ data: fresh, offline: true, evict: false });
    }
  });

  it('deletes the copy when access was revoked or the thing is gone', () => {
    for (const status of [403, 404, 410]) {
      expect(offlineView({ fresh: null, saved, missStatus: status })).toEqual({ data: null, offline: false, evict: true });
    }
  });

  it('deletes the copy on disk even when it was never read into memory', () => {
    // first open: the answer was saved to disk but `saved` (the earlier disk read) was empty
    for (const status of [403, 404, 410]) {
      expect(offlineView({ fresh, saved: null, missStatus: status })).toEqual({ data: null, offline: false, evict: true });
      expect(offlineView({ fresh: null, saved: null, missStatus: status })).toEqual({ data: null, offline: false, evict: true });
    }
  });

  it('shows another error instead of any copy, also after an earlier answer', () => {
    expect(offlineView({ fresh: null, saved, missStatus: 500 })).toEqual({ data: null, offline: false, evict: false });
    expect(offlineView({ fresh, saved, missStatus: 500 })).toEqual({ data: null, offline: false, evict: false });
    expect(offlineView({ fresh, saved: null, missStatus: 400 })).toEqual({ data: null, offline: false, evict: false });
  });
});
