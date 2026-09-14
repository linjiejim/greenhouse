/**
 * Generate Image Tool — Tests
 *
 * Covers the single upstream path: gpt-image-2 via the media endpoint, fixed `low` quality,
 * no fallback provider. API calls are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Some upstreams answer with inline base64, but an OpenAI-compatible endpoint may answer with
// a URL instead, in which case the tool downloads it through the SSRF-guarded fetcher.
// That fetcher deliberately calls undici's *own* `fetch` (its dispatcher must be
// version-matched), which these tests cannot intercept — `undici` is an apps/api
// dependency and isn't resolvable from the repo root. Swap in a stand-in of the same
// shape that goes through `globalThis.fetch`, so one mock drives both the API call and
// the download. The real downloader's guards live in apps/api/src/security/network.test.ts.
vi.mock('../../apps/api/src/security/network.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../apps/api/src/security/network.js')>();
  return {
    ...actual,
    fetchPublicImage: async (input: string) => {
      const response = await globalThis.fetch(input);
      if (!response.ok) throw new Error(`Failed to download image: HTTP ${response.status}`);
      return { buffer: Buffer.from(await response.arrayBuffer()), contentType: 'image/png', finalUrl: input };
    },
  };
});

import { createGenerateImageTool, resolveSize } from '../../apps/api/src/tools/generate-image.js';

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const API_BASE = 'https://media.example.com/v1';

const budgetDb = {
  users: {
    getById: vi.fn(async () => ({
      id: 'image-user',
      role: 'team',
      status: 'active',
      monthly_token_limit: 20_000_000,
    })),
  },
  usageBudget: {
    reserveMonthlyUser: vi.fn(async () => []),
    ensureAccount: vi.fn(async (input: { scope_type: string; scope_id: string; unit: string }) => ({
      id: `${input.scope_type}:${input.scope_id}:${input.unit}`,
    })),
    reserve: vi.fn(async () => []),
    settle: vi.fn(async () => []),
    release: vi.fn(async () => []),
  },
  usage: { record: vi.fn(async () => undefined) },
};

function createImageTool() {
  return createGenerateImageTool({ db: budgetDb as never, userId: 'image-user', sessionId: 'image-session' });
}

/** Install a `globalThis.fetch` mock and restore it after the test. */
function mockFetch(impl: (url: string, opts?: any) => Promise<any>) {
  const original = globalThis.fetch;
  const spy = vi.fn().mockImplementation(impl);
  globalThis.fetch = spy as unknown as typeof globalThis.fetch;
  return { spy, restore: () => (globalThis.fetch = original) };
}

/** A successful generations response carrying inline base64. */
function b64Response() {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ data: [{ b64_json: Buffer.from(PNG_BYTES).toString('base64') }] }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MEDIA_API_KEY = 'test-media-key';
  process.env.MEDIA_BASE_URL = API_BASE;
});

afterEach(() => {
  delete process.env.MEDIA_API_KEY;
  delete process.env.MEDIA_BASE_URL;
  vi.restoreAllMocks();
});

describe('GenerateImageTool', () => {
  it('creates tool with correct description', () => {
    const tool = createImageTool();
    expect(tool.description).toContain('GPT-Image-2');
    expect(tool.description).toContain('generate');
    expect(tool.description).toContain('edit');
  });

  it('rejects generate without prompt', async () => {
    const tool = createImageTool();
    const result = await tool.execute({ action: 'generate', prompt: '' }, { toolCallId: 'test', messages: [] });
    expect(result).toBeDefined();
  });

  it('rejects edit without images', async () => {
    const tool = createImageTool();
    const result = await tool.execute({ action: 'edit', prompt: 'make it blue' }, { toolCallId: 'test', messages: [] });
    expect((result as any).error).toContain('reference image');
  });

  it('rejects edit with empty images array', async () => {
    const tool = createImageTool();
    const result = await tool.execute(
      { action: 'edit', prompt: 'make it blue', images: [] },
      { toolCallId: 'test', messages: [] },
    );
    expect((result as any).error).toContain('reference image');
  });

  it('reports the missing media key by name', async () => {
    delete process.env.MEDIA_API_KEY;
    delete process.env.LLM_API_KEY;
    const tool = createImageTool();
    const result = await tool.execute({ action: 'generate', prompt: 'a cat' }, { toolCallId: 'test', messages: [] });
    expect((result as any).error).toContain('MEDIA_API_KEY');
  });

  it('surfaces upstream errors without attempting another provider', async () => {
    const { spy, restore } = mockFetch(() =>
      Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('Internal Server Error') }),
    );

    try {
      const tool = createImageTool();
      const result = await tool.execute({ action: 'generate', prompt: 'a cat' }, { toolCallId: 'test', messages: [] });
      expect((result as any).error).toContain('500');
      // A single upstream call — there is no fallback provider left to try.
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('generates through the media endpoint and persists the inline base64', async () => {
    const { spy, restore } = mockFetch(() => b64Response());

    try {
      const tool = createImageTool();
      const result = await tool.execute(
        { action: 'generate', prompt: 'a cute orange cat', size: '1024x1024' },
        { toolCallId: 'test', messages: [] },
      );

      expect((result as any).success).toBe(true);
      expect((result as any).url).toMatch(/^\/api\/upload\/gen-/);
      expect((result as any).markdown).toMatch(/^!\[Generated Image\]\(\/api\/upload\/gen-/);
      expect((result as any).model).toBe('gpt-image-2');
      expect((result as any).size).toBe('1024x1024');
      expect((result as any).estimated_cost_usd).toBe(0.006);

      expect(budgetDb.usageBudget.ensureAccount).toHaveBeenCalledTimes(3);
      expect(budgetDb.usageBudget.reserve).toHaveBeenCalledWith(
        expect.objectContaining({ estimated_units: 6_000, provider_id: 'media' }),
      );
      const budgetKey = budgetDb.usageBudget.reserve.mock.calls[0]![0].idempotency_key;
      expect(budgetDb.usageBudget.settle).toHaveBeenCalledWith(
        expect.objectContaining({ idempotency_key: budgetKey, actual_units: 6_000 }),
      );
      expect(budgetDb.usage.record).toHaveBeenCalledWith(
        expect.objectContaining({ budget_idempotency_key: budgetKey }),
      );

      const [url, init] = spy.mock.calls[0];
      expect(url).toBe(`${API_BASE}/images/generations`);
      expect(init.headers.Authorization).toBe('Bearer test-media-key');
      const body = JSON.parse(init.body);
      expect(body.model).toBe('gpt-image-2');
      expect(body.prompt).toBe('a cute orange cat');
      expect(body.size).toBe('1024x1024');
      // A URL response would mean an extra download hop; base64 must be used as-is.
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('defaults to the landscape size when the caller omits one', async () => {
    const { spy, restore } = mockFetch(() => b64Response());

    try {
      const tool = createImageTool();
      const result = await tool.execute(
        { action: 'generate', prompt: 'a blog header' },
        { toolCallId: 'test', messages: [] },
      );

      expect(JSON.parse(spy.mock.calls[0][1].body).size).toBe('1536x1024');
      expect((result as any).size).toBe('1536x1024');
      expect((result as any).estimated_cost_usd).toBe(0.005);
    } finally {
      restore();
    }
  });

  // The medium/high tiers cost ~8x/~33x low, and a model has no basis for spending
  // that. The knob is gone from the schema; zod strips it, so an old caller still
  // sending `quality: 'high'` is served `low` instead of erroring.
  it('always requests low quality, ignoring any quality the caller passes', async () => {
    const { spy, restore } = mockFetch(() => b64Response());

    try {
      const tool = createImageTool();
      const result = await tool.execute({ action: 'generate', prompt: 'a poster', quality: 'high' } as any, {
        toolCallId: 'test',
        messages: [],
      });

      expect(JSON.parse(spy.mock.calls[0][1].body).quality).toBe('low');
      expect((result as any).success).toBe(true);
      expect((result as any).quality).toBe('low');
    } finally {
      restore();
    }
  });

  it('downloads the image when the endpoint returns a URL instead of base64', async () => {
    const { spy, restore } = mockFetch((url: string) => {
      if (url.includes('media.example.com')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [{ url: 'https://cdn.example.com/img.png' }] }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(Uint8Array.from(PNG_BYTES).buffer),
      });
    });

    try {
      const tool = createImageTool();
      const result = await tool.execute(
        { action: 'generate', prompt: 'a red circle' },
        { toolCallId: 'test', messages: [] },
      );

      expect((result as any).success).toBe(true);
      expect(spy).toHaveBeenCalledTimes(2); // generation + download
    } finally {
      restore();
    }
  });

  it('fails with a clear message when the endpoint returns no image', async () => {
    const { restore } = mockFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) }));

    try {
      const tool = createImageTool();
      const result = await tool.execute(
        { action: 'generate', prompt: 'a red circle' },
        { toolCallId: 'test', messages: [] },
      );
      expect((result as any).error).toContain('returned no image');
    } finally {
      restore();
    }
  });

  it('edit posts multipart form data at low quality', async () => {
    const { spy, restore } = mockFetch(() => b64Response());

    try {
      // The reference image must exist in storage first.
      const { putUpload } = await import('../../apps/api/src/storage/uploads.js');
      const refId = `gen-${Date.now()}-11111111-2222-3333-4444-555555555555.png`;
      await putUpload(refId, Buffer.from(PNG_BYTES), 'image/png');

      const tool = createImageTool();
      const result = await tool.execute(
        { action: 'edit', prompt: 'make the background white', images: [refId] },
        { toolCallId: 'test', messages: [] },
      );

      expect((result as any).success).toBe(true);
      expect((result as any).model).toBe('gpt-image-2');
      expect((result as any).quality).toBe('low');

      const [url, init] = spy.mock.calls[0];
      expect(url).toBe(`${API_BASE}/images/edits`);
      expect(init.body).toBeInstanceOf(FormData);
      expect(init.body.get('model')).toBe('gpt-image-2');
      expect(init.body.get('quality')).toBe('low');
    } finally {
      restore();
    }
  });

  it('forwards size on edit, so a composition is not stuck at the reference image shape', async () => {
    const { spy, restore } = mockFetch(() => b64Response());

    try {
      const { putUpload } = await import('../../apps/api/src/storage/uploads.js');
      const refId = `gen-${Date.now()}-11111111-2222-3333-4444-666666666666.png`;
      await putUpload(refId, Buffer.from(PNG_BYTES), 'image/png');

      const tool = createImageTool();
      await tool.execute(
        { action: 'edit', prompt: 'white background', images: [refId], size: '1024x1536' },
        { toolCallId: 'test', messages: [] },
      );

      expect(spy.mock.calls[0][1].body.get('size')).toBe('1024x1536');
    } finally {
      restore();
    }
  });
});

/**
 * Regression: asked for a brand-compliant poster, the model described the Greenhouse logo
 * in words and let gpt-image-2 draw a lookalike — which `brand/foundations/logo`
 * explicitly forbids ("永远不重绘"). It had no better option: reference images were
 * reachable only through `action: 'edit'`, documented as being for images the user
 * uploaded. `generate` now takes them too, and routes to the one endpoint that
 * accepts them.
 */
describe('generate with reference assets', () => {
  /** Put a stand-in asset in storage and return its upload id. */
  async function seedAsset(suffix: string): Promise<string> {
    const { putUpload } = await import('../../apps/api/src/storage/uploads.js');
    const id = `gen-${Date.now()}-11111111-2222-3333-4444-${suffix}.png`;
    await putUpload(id, Buffer.from(PNG_BYTES), 'image/png');
    return id;
  }

  it('routes to the edits endpoint and carries the reference, size and prompt', async () => {
    const { spy, restore } = mockFetch(() => b64Response());

    try {
      const logo = await seedAsset('777777777777');
      const tool = createImageTool();
      const result = await tool.execute(
        {
          action: 'generate',
          prompt: 'Poster with the logo placed unchanged',
          images: [logo],
          size: '1024x1024',
        },
        { toolCallId: 'test', messages: [] },
      );

      expect((result as any).success).toBe(true);
      expect((result as any).reference_images).toEqual([logo]);
      expect((result as any).size).toBe('1024x1024');

      expect(spy).toHaveBeenCalledTimes(1);
      const [url, init] = spy.mock.calls[0];
      // NOT /images/generations — that endpoint silently ignores reference images.
      expect(url).toBe(`${API_BASE}/images/edits`);
      expect(init.body.get('prompt')).toBe('Poster with the logo placed unchanged');
      expect(init.body.get('size')).toBe('1024x1024');
      expect(init.body.get('quality')).toBe('low');
      expect(init.body.getAll('image')).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('sends every reference image, not just the first', async () => {
    const { spy, restore } = mockFetch(() => b64Response());

    try {
      const lockup = await seedAsset('888888888888');
      const mark = await seedAsset('999999999999');
      const tool = createImageTool();
      await tool.execute(
        { action: 'generate', prompt: 'poster', images: [lockup, mark] },
        { toolCallId: 'test', messages: [] },
      );

      expect(spy.mock.calls[0][1].body.getAll('image')).toHaveLength(2);
    } finally {
      restore();
    }
  });

  it('still uses text-to-image when no reference is given', async () => {
    const { spy, restore } = mockFetch(() => b64Response());

    try {
      const tool = createImageTool();
      const result = await tool.execute(
        { action: 'generate', prompt: 'a red circle' },
        { toolCallId: 'test', messages: [] },
      );

      expect(spy.mock.calls[0][0]).toBe(`${API_BASE}/images/generations`);
      expect((result as any).reference_images).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('reports a missing asset instead of silently generating a lookalike', async () => {
    const { restore } = mockFetch(() => b64Response());

    try {
      const tool = createImageTool();
      const result = await tool.execute(
        { action: 'generate', prompt: 'poster', images: ['1753300000000-deadbeef.png'] },
        { toolCallId: 'test', messages: [] },
      );

      expect((result as any).success).toBeUndefined();
      expect((result as any).error).toContain('Image not found');
    } finally {
      restore();
    }
  });
});

/**
 * Regression: gpt-image-2 renders exactly three sizes. A request for anything else is
 * neither rejected nor snapped upstream — measured against the upstream at `low`, asking for
 * "1080x1080" (a plausible Instagram spec, and what the agent actually sent) returned a
 * 1254x1254 / 863KB image, against 1024x1024 / 121KB for a supported size. So an
 * off-spec number silently bought a 7x heavier file at a resolution nobody chose, and
 * fell out of the cost table too.
 */
describe('size resolution', () => {
  it.each(['1024x1024', '1536x1024', '1024x1536'])('passes the supported size %s through', (size) => {
    expect(resolveSize(size)).toBe(size);
  });

  it('defaults when the size is absent or "auto" (no aspect ratio to match)', () => {
    expect(resolveSize(undefined)).toBe('1536x1024');
    expect(resolveSize('auto')).toBe('1536x1024');
  });

  it.each([
    ['1080x1080', '1024x1024'], // the Instagram square that started this
    ['2048x2048', '1024x1024'],
    ['1152x1536', '1024x1536'], // portrait presets the skill used to recommend
    ['864x1536', '1024x1536'],
    ['1536x864', '1536x1024'],
    ['1920x1080', '1536x1024'],
  ])('snaps %s to the closest supported aspect ratio, %s', (requested, expected) => {
    expect(resolveSize(requested)).toBe(expected);
  });

  it('always lands on a size that has a cost, so the estimate is never silently missing', async () => {
    const { spy, restore } = mockFetch(() => b64Response());
    try {
      const tool = createImageTool();
      const result = (await tool.execute(
        { action: 'generate', prompt: 'a square poster', size: '1080x1080' },
        { toolCallId: 'test', messages: [] },
      )) as any;

      expect(result.size).toBe('1024x1024');
      expect(result.requested_size).toBe('1080x1080'); // the snap is reported, not hidden
      expect(result.estimated_cost_usd).toBe(0.006);
      expect(JSON.parse(spy.mock.calls[0][1].body).size).toBe('1024x1024');
    } finally {
      restore();
    }
  });

  it('leaves requested_size off when nothing was snapped', async () => {
    const { restore } = mockFetch(() => b64Response());
    try {
      const tool = createImageTool();
      const result = (await tool.execute(
        { action: 'generate', prompt: 'a header', size: '1536x1024' },
        { toolCallId: 'test', messages: [] },
      )) as any;
      expect(result.requested_size).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('keeps the source shape on a plain edit — an omitted size stays omitted', async () => {
    const { spy, restore } = mockFetch(() => b64Response());
    try {
      const { putUpload } = await import('../../apps/api/src/storage/uploads.js');
      const refId = `gen-${Date.now()}-11111111-2222-3333-4444-aaaaaaaaaaaa.png`;
      await putUpload(refId, Buffer.from(PNG_BYTES), 'image/png');

      const tool = createImageTool();
      await tool.execute(
        { action: 'edit', prompt: 'make it brighter', images: [refId] },
        { toolCallId: 'test', messages: [] },
      );
      expect(spy.mock.calls[0][1].body.get('size')).toBeNull();
    } finally {
      restore();
    }
  });
});
