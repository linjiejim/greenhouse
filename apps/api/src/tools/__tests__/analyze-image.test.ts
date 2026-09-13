import { describe, expect, it, vi } from 'vitest';
import {
  analyzeImageSchema,
  buildVisionPrompt,
  createAnalyzeImageTool,
  estimateVisionRequestTokens,
  MAX_VISION_QUESTION_CHARS,
} from '../analyze-image.js';

describe('analyze_image prompt', () => {
  it('treats images as general source material without a plant-first assumption', () => {
    const prompt = buildVisionPrompt();

    expect(prompt).toContain('neutral source material');
    expect(prompt).toContain('screenshot, email, document, chart');
    expect(prompt).toContain('readable text, names, dates, numbers');
    expect(prompt).toContain('visible facts from inference');
    expect(prompt).not.toContain('hydroponic gardening customer');
    expect(prompt).not.toContain('nutrient deficiency');
  });

  it('preserves the user request as the analysis focus', () => {
    expect(buildVisionPrompt('Summarize the action items in this email')).toContain(
      "User's request: Summarize the action items in this email",
    );
  });

  it('caps the question and reserves a UTF-8 byte upper bound for high-entropy input', () => {
    expect(
      analyzeImageSchema.safeParse({ image_id: 'upload-1', question: 'x'.repeat(MAX_VISION_QUESTION_CHARS + 1) })
        .success,
    ).toBe(false);

    const question = '🧪'.repeat(2_000);
    const promptBytes = Buffer.byteLength(buildVisionPrompt(question), 'utf8');
    expect(estimateVisionRequestTokens(question)).toBeGreaterThan(promptBytes);
  });
});

function budgetDb(events: string[]) {
  const reserveMonthlyUser = vi.fn(async (_input: Record<string, unknown>) => {
    events.push('reserve');
  });
  const settle = vi.fn(async (_input: Record<string, unknown>) => {
    events.push('settle');
  });
  const release = vi.fn(async (_input: Record<string, unknown>) => {
    events.push('release');
  });
  const record = vi.fn(async (_input: Record<string, unknown>) => {
    events.push('record');
  });
  return {
    db: {
      users: {
        getById: vi.fn(async () => ({
          id: 'user-1',
          role: 'team',
          status: 'active',
          monthly_token_limit: 1_000_000,
        })),
      },
      usageBudget: { reserveMonthlyUser, settle, release },
      usage: { record },
    },
    record,
    release,
    reserveMonthlyUser,
    settle,
  };
}

describe('analyze_image usage budget', () => {
  it('loads local input before reserving, then settles and links successful provider usage', async () => {
    const events: string[] = [];
    const f = budgetDb(events);
    const tool = createAnalyzeImageTool({
      db: f.db as never,
      userId: 'user-1',
      sessionId: 'session-1',
      loadImage: async () => {
        events.push('load');
        return { buffer: Buffer.from('image'), contentType: 'image/png' };
      },
      prepareModel: async () => {
        events.push('prepare');
        return { model: {} as never, modelId: 'vision-test' };
      },
      generate: async () => {
        events.push('provider');
        return { text: 'visible facts', usage: { inputTokens: 30, outputTokens: 7 } };
      },
    });

    const output = (await tool.execute!({ image_id: 'upload-1' }, {} as never)) as Record<string, unknown>;

    expect(output.description).toBe('visible facts');
    expect(events).toEqual(['load', 'prepare', 'reserve', 'provider', 'settle', 'record']);
    expect(f.reserveMonthlyUser).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user-1', caller: 'vision', run_id: 'session-1' }),
    );
    const budgetKey = f.reserveMonthlyUser.mock.calls[0]![0].idempotency_key as string;
    expect(f.settle).toHaveBeenCalledWith(expect.objectContaining({ idempotency_key: budgetKey, actual_units: 37 }));
    expect(f.record).toHaveBeenCalledWith(expect.objectContaining({ budget_idempotency_key: budgetKey }));
  });

  it('does not reserve when the image cannot be loaded', async () => {
    const events: string[] = [];
    const f = budgetDb(events);
    const tool = createAnalyzeImageTool({
      db: f.db as never,
      userId: 'user-1',
      loadImage: async () => null,
    });

    const output = (await tool.execute!({ image_id: 'missing' }, {} as never)) as { error?: string };

    expect(output.error).toMatch(/not found/i);
    expect(f.reserveMonthlyUser).not.toHaveBeenCalled();
  });

  it('keeps the reservation when the provider attempt has an unknown outcome', async () => {
    const events: string[] = [];
    const f = budgetDb(events);
    const tool = createAnalyzeImageTool({
      db: f.db as never,
      userId: 'user-1',
      loadImage: async () => ({ buffer: Buffer.from('image'), contentType: 'image/png' }),
      prepareModel: async () => ({ model: {} as never, modelId: 'vision-test' }),
      generate: async () => {
        throw new Error('socket closed');
      },
    });

    const output = (await tool.execute!({ image_id: 'upload-1' }, {} as never)) as { error?: string };

    expect(output.error).toContain('socket closed');
    expect(f.reserveMonthlyUser).toHaveBeenCalledTimes(1);
    expect(f.settle).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
  });
});
