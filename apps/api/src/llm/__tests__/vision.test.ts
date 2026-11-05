import { describe, expect, it, vi } from 'vitest';
import { fakeMeteringServices, routeReserve } from '../../../../../tests/helpers/metering-db.js';
import { analyzeImages, estimateVisionTokens, VISION_IMAGE_TOKEN_ALLOWANCE } from '../vision.js';
import type { DatabaseProvider } from '@greenhouse/db';

// 1×1 PNG and a minimal JPEG header: enough for the magic-byte check.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);

function budgetDb() {
  const reserved: Array<Record<string, unknown>> = [];
  const settled: Array<Record<string, unknown>> = [];
  const metered = fakeMeteringServices();
  const db = {
    metering: metered.metering,
    users: { getById: vi.fn(async () => ({ id: 'user-1', role: 'team', status: 'active' })) },
    usageBudget: {
      settle: vi.fn(async (input: Record<string, unknown>) => void settled.push(input)),
      release: vi.fn(async () => {}),
      ensureAccount: metered.ensureAccount,
      reserve: routeReserve(
        vi.fn(async (input: Record<string, unknown>) => void reserved.push(input)),
        metered.reserve,
      ),
    },
    usage: { record: vi.fn(async () => {}) },
  } as unknown as DatabaseProvider;
  return { db, reserved, settled };
}

const prepareModel = async () => ({ model: {} as never, modelId: 'vision-test' });

describe('analyzeImages', () => {
  it('sends every image in one metered call and reserves an allowance per image', async () => {
    const { db, reserved, settled } = budgetDb();
    const generate = vi.fn(async ({ images }: { images: Array<{ mimeType: string }> }) => ({
      text: `saw ${images.map((image) => image.mimeType).join(',')}`,
      usage: { inputTokens: 10, outputTokens: 5 },
    }));
    const result = await analyzeImages(
      { userId: 'user-1', images: [{ bytes: PNG }, { bytes: JPEG }], prompt: 'What is shown?', caller: 'assets' },
      { db, prepareModel, generate },
    );
    expect(result).toMatchObject({ text: 'saw image/png,image/jpeg', model: 'vision-test' });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(reserved[0]).toMatchObject({ caller: 'assets', estimated_units: expect.any(Number) });
    expect(reserved[0].estimated_units as number).toBeGreaterThanOrEqual(2 * VISION_IMAGE_TOKEN_ALLOWANCE);
    expect(settled).toHaveLength(1);
  });

  it('parses a JSON reply when asked, and leaves prose alone', async () => {
    const { db } = budgetDb();
    const json = await analyzeImages(
      { userId: 'user-1', images: [{ bytes: PNG }], prompt: 'Tag it', json: true, caller: 'assets' },
      { db, prepareModel, generate: async () => ({ text: '```json\n{"tags":["basil"]}\n```' }) },
    );
    expect(json.json).toEqual({ tags: ['basil'] });
    const prose = await analyzeImages(
      { userId: 'user-1', images: [{ bytes: PNG }], prompt: 'Tag it', json: true, caller: 'assets' },
      { db, prepareModel, generate: async () => ({ text: 'no json here' }) },
    );
    expect(prose.json).toBeUndefined();
  });

  it('refuses bad input before reserving anything', async () => {
    const { db, reserved } = budgetDb();
    const call = (input: Partial<Parameters<typeof analyzeImages>[0]>) =>
      analyzeImages(
        { userId: 'user-1', images: [{ bytes: PNG }], prompt: 'x', caller: 'assets', ...input },
        {
          db,
          prepareModel,
          generate: async () => ({ text: 'x' }),
        },
      );
    await expect(call({ images: [] })).rejects.toThrow(/1–8 images/);
    await expect(call({ images: Array.from({ length: 9 }, () => ({ bytes: PNG })) })).rejects.toThrow(/1–8/);
    await expect(call({ images: [{ bytes: Buffer.from('<svg/>') }] })).rejects.toThrow(/not a jpeg/);
    await expect(call({ prompt: ' ' })).rejects.toThrow(/prompt/);
    await expect(call({ maxOutputTokens: 5000 })).rejects.toThrow(/maxOutputTokens/);
    expect(reserved).toHaveLength(0);
  });

  it('estimates conservatively for non-Latin prompts', () => {
    const prompt = '图'.repeat(1000);
    expect(estimateVisionTokens(prompt, 1, 100)).toBeGreaterThan(Buffer.byteLength(prompt) + 100);
  });
});
