import { describe, expect, it, vi } from 'vitest';
import { feishuLoginAvailable } from './availability';

const response = (body: unknown, ok = true) => ({ ok, json: async () => body });

describe('public Feishu sign-in discovery', () => {
  it('uses the provider registry', async () => {
    const fetcher = vi.fn(async () => response({ providers: [{ id: 'feishu', title: 'Feishu', login: true }] }));
    expect(await feishuLoginAvailable(fetcher)).toBe(true);
    expect(fetcher.mock.calls).toEqual([['/api/auth/providers']]);
  });

  it.each([null, {}, [], { providers: [] }, { providers: [{ id: 'wecom' }] }, { providers: [null, {}, 'feishu'] }])(
    'hides Feishu when it is absent or the answer is malformed: %j',
    async (body) => {
      expect(await feishuLoginAvailable(async () => response(body))).toBe(false);
    },
  );

  it('does not fall back to plugin routes when discovery fails', async () => {
    const fetcher = vi.fn(async () => response(null, false));
    expect(await feishuLoginAvailable(fetcher)).toBe(false);
    expect(fetcher.mock.calls).toEqual([['/api/auth/providers']]);
  });
});
