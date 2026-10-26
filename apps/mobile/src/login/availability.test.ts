import { describe, expect, it, vi } from 'vitest';
import { feishuLoginAvailable } from './availability';

const response = (body: unknown, ok = true) => ({ ok, json: async () => body });

describe('public Feishu sign-in discovery', () => {
  it.each([4, 5])('uses the provider registry on API %s', async (level) => {
    const fetcher = vi.fn(async () => response({ providers: [{ id: 'feishu', title: 'Feishu', login: true }] }));
    expect(await feishuLoginAvailable(level, fetcher)).toBe(true);
    expect(fetcher.mock.calls).toEqual([['/api/auth/providers']]);
  });

  it('keeps the API 3 legacy probe', async () => {
    const fetcher = vi.fn(async () => response({ available: true }));
    expect(await feishuLoginAvailable(3, fetcher)).toBe(true);
    expect(fetcher.mock.calls).toEqual([['/api/feishu/login-available']]);
    expect(await feishuLoginAvailable(3, async () => response({ available: false }))).toBe(false);
    expect(await feishuLoginAvailable(3, async () => response({ available: 'true' }))).toBe(false);
  });

  it.each([null, {}, [], { providers: [] }, { providers: [{ id: 'wecom' }] }, { providers: [null, {}, 'feishu'] }])(
    'hides Feishu when it is absent or the answer is malformed: %j',
    async (body) => {
      expect(await feishuLoginAvailable(4, async () => response(body))).toBe(false);
    },
  );

  it('does not fall back to plugin routes when discovery fails', async () => {
    const fetcher = vi.fn(async () => response(null, false));
    expect(await feishuLoginAvailable(4, fetcher)).toBe(false);
    expect(fetcher.mock.calls).toEqual([['/api/auth/providers']]);
  });
});
