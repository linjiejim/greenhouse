import { beforeEach, expect, it, vi } from 'vitest';
import { schemaRoutes } from '../tables/schema.js';

const mocks = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock('../tables/shared.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tables/shared.js')>()),
  dispatch: mocks.dispatch,
}));

beforeEach(() => {
  mocks.dispatch.mockReset();
  mocks.dispatch.mockResolvedValue({
    ok: true,
    data: { fieldId: 4, counts: { queued: 0, running: 0, failed: 0 }, usage: { tokens: 0, cap: 1000 }, records: {} },
  });
});

it.each([
  ['', []],
  ['?recordIds=', []],
  ['?recordIds=12,34', [12, 34]],
] as const)('parses the typed AI status query %s', async (query, ids) => {
  const response = await schemaRoutes.request(`/fields/4/ai/status${query}`);
  expect(response.status).toBe(200);
  expect(mocks.dispatch).toHaveBeenCalledWith(
    expect.anything(),
    'getAiFieldStatus',
    { fieldId: 4, recordIds: ids },
    { fieldId: 4 },
  );
});

it.each(['0', '1,nope', '1,,2', '9007199254740992', Array.from({ length: 201 }, (_, id) => id + 1).join(',')])(
  'rejects invalid AI status IDs without dispatching: %s',
  async (ids) => {
    const response = await schemaRoutes.request(`/fields/4/ai/status?recordIds=${ids}`);
    expect(response.status).toBe(400);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  },
);

it('rejects repeated recordIds parameters rather than silently discarding one', async () => {
  const response = await schemaRoutes.request('/fields/4/ai/status?recordIds=1&recordIds=2');
  expect(response.status).toBe(400);
  expect(mocks.dispatch).not.toHaveBeenCalled();
});
