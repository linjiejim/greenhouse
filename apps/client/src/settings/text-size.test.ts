/**
 * The account text size (./text-size.ts): a slow first read of the account's size never
 * overwrites a size the member picked while it was on its way. Runs in the ROOT vitest unit
 * project: react, the stores and the API client are mocked.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('react', () => ({ useEffect: () => {} }));
const prefs = { step: 1, setTextStep: vi.fn((step: number) => (prefs.step = step)) };
vi.mock('../store/prefs', () => ({ usePrefs: { getState: () => prefs } }));
vi.mock('../store/auth', () => ({ useAuth: { getState: () => ({ user: { id: 'u' } }) } }));
vi.mock('../store/stations', () => ({ useStations: { getState: () => ({ activeId: 's' }) } }));
vi.mock('../data/identity', () => ({ captureIdentity: () => () => true }));
let answer: (value: unknown) => void = () => {};
vi.mock('../api/client', () => ({
  get: () => new Promise((resolve) => (answer = resolve)),
  patch: async () => ({ ok: true, data: {} }),
}));

const { chooseTextSize, loadAccountTextSize } = await import('./text-size');
const { TEXT_STEPS } = await import('../theme/type-scale');

describe('the account text size', () => {
  it('keeps the size picked while the account read was slow', async () => {
    const loading = loadAccountTextSize();
    chooseTextSize(4);
    answer({ ok: true, data: { fontScale: TEXT_STEPS[0] } });
    await loading;
    expect(prefs.step).toBe(4);
  });

  it('applies the account size when nothing was picked meanwhile', async () => {
    const loading = loadAccountTextSize();
    answer({ ok: true, data: { fontScale: TEXT_STEPS[0] } });
    await loading;
    expect(prefs.step).toBe(0);
  });
});
