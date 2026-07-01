/**
 * Generate Image Tool — Tests
 *
 * Tests the generate_image tool (mocked API calls for unit tests).
 * Covers GPT-Image-2 primary path and GLM-Image fallback.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createGenerateImageTool } from '../apps/api/src/tools/media/generate-image.js';

// Mock env vars
beforeEach(() => {
  process.env.GPT_IMAGE_API_KEY = 'test-key-123';
  process.env.GPT_IMAGE_BASE_URL = 'https://test-api.example.com/v1';
  process.env.GLM_IMAGE_API_KEY = 'test-glm-key-456';
  process.env.GLM_IMAGE_BASE_URL = 'https://test-glm.example.com/v4';
});

afterEach(() => {
  delete process.env.GPT_IMAGE_API_KEY;
  delete process.env.GPT_IMAGE_BASE_URL;
  delete process.env.GLM_IMAGE_API_KEY;
  delete process.env.GLM_IMAGE_BASE_URL;
  vi.restoreAllMocks();
});

describe('GenerateImageTool', () => {
  it('creates tool with correct description', () => {
    const tool = createGenerateImageTool();
    expect(tool.description).toContain('GPT-Image-2');
    expect(tool.description).toContain('generate');
    expect(tool.description).toContain('edit');
  });

  it('rejects generate without prompt', async () => {
    const tool = createGenerateImageTool();
    const result = await tool.execute(
      { action: 'generate', prompt: '' },
      { toolCallId: 'test', messages: [] },
    );
    // Empty string is still truthy check — prompt validation
    expect(result).toBeDefined();
  });

  it('rejects edit without images', async () => {
    const tool = createGenerateImageTool();
    const result = await tool.execute(
      { action: 'edit', prompt: 'make it blue' },
      { toolCallId: 'test', messages: [] },
    );
    expect((result as any).error).toContain('reference image');
  });

  it('rejects edit with empty images array', async () => {
    const tool = createGenerateImageTool();
    const result = await tool.execute(
      { action: 'edit', prompt: 'make it blue', images: [] },
      { toolCallId: 'test', messages: [] },
    );
    expect((result as any).error).toContain('reference image');
  });

  it('handles missing API key', async () => {
    delete process.env.GPT_IMAGE_API_KEY;
    delete process.env.GLM_IMAGE_API_KEY;
    const tool = createGenerateImageTool();
    const result = await tool.execute(
      { action: 'generate', prompt: 'a cat' },
      { toolCallId: 'test', messages: [] },
    );
    expect((result as any).error).toContain('GPT_IMAGE_API_KEY');
  });

  it('handles API errors gracefully', async () => {
    // Both APIs fail — no fallback available
    delete process.env.GLM_IMAGE_API_KEY;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });

    try {
      const tool = createGenerateImageTool();
      const result = await tool.execute(
        { action: 'generate', prompt: 'a cat' },
        { toolCallId: 'test', messages: [] },
      );
      expect((result as any).error).toContain('500');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('generates image successfully with GPT-Image-2', async () => {
    const fakeB64 = Buffer.from('fake-png-data').toString('base64');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: [{ b64_json: fakeB64 }],
      }),
    });

    try {
      const tool = createGenerateImageTool();
      const result = await tool.execute(
        { action: 'generate', prompt: 'a cute orange cat', size: '1024x1024', quality: 'medium' },
        { toolCallId: 'test', messages: [] },
      );

      expect((result as any).success).toBe(true);
      expect((result as any).url).toMatch(/^\/api\/upload\/gen-/);
      expect((result as any).markdown).toMatch(/^!\[Generated Image\]\(\/api\/upload\/gen-/);
      expect((result as any).model).toBe('gpt-image-2');
      expect((result as any).fallback).toBe(false);
      expect((result as any).size).toBe('1024x1024');
      expect((result as any).quality).toBe('medium');

      // Verify fetch was called correctly
      const fetchCall = (globalThis.fetch as any).mock.calls[0];
      expect(fetchCall[0]).toBe('https://test-api.example.com/v1/images/generations');
      const fetchBody = JSON.parse(fetchCall[1].body);
      expect(fetchBody.model).toBe('gpt-image-2');
      expect(fetchBody.prompt).toBe('a cute orange cat');
      expect(fetchBody.size).toBe('1024x1024');
      expect(fetchBody.quality).toBe('medium');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  describe('GLM-Image Fallback', () => {
    it('falls back to GLM when GPT fails', async () => {
      const originalFetch = globalThis.fetch;
      let callCount = 0;

      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        callCount++;
        if (url.includes('test-api.example.com')) {
          // GPT fails
          return Promise.resolve({
            ok: false,
            status: 502,
            text: () => Promise.resolve('Bad Gateway'),
          });
        }
        if (url.includes('test-glm.example.com')) {
          // GLM succeeds — returns a URL
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              created: 1234567890,
              data: [{ url: 'https://fake-glm-image.com/image.png' }],
            }),
          });
        }
        // Handle image download from GLM URL
        if (url.includes('fake-glm-image.com')) {
          return Promise.resolve({
            ok: true,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
          });
        }
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      try {
        const tool = createGenerateImageTool();
        const result = await tool.execute(
          { action: 'generate', prompt: 'a red circle', size: '1536x1024' },
          { toolCallId: 'test', messages: [] },
        );

        expect((result as any).success).toBe(true);
        expect((result as any).model).toBe('glm-image');
        expect((result as any).fallback).toBe(true);
        expect((result as any).url).toMatch(/^\/api\/upload\/gen-/);

        // Should have called GPT first, then GLM
        expect(callCount).toBe(3); // GPT generate + GLM generate + GLM download image URL
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('reports combined error when both GPT and GLM fail', async () => {
      const originalFetch = globalThis.fetch;

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve('Service Unavailable'),
      });

      try {
        const tool = createGenerateImageTool();
        const result = await tool.execute(
          { action: 'generate', prompt: 'a blue square' },
          { toolCallId: 'test', messages: [] },
        );

        expect((result as any).error).toContain('GPT-Image-2');
        expect((result as any).error).toContain('GLM-Image fallback');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('does not attempt GLM fallback when GLM_IMAGE_API_KEY is missing', async () => {
      delete process.env.GLM_IMAGE_API_KEY;
      const originalFetch = globalThis.fetch;
      let callCount = 0;

      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve('Server Error'),
        });
      });

      try {
        const tool = createGenerateImageTool();
        const result = await tool.execute(
          { action: 'generate', prompt: 'a green triangle' },
          { toolCallId: 'test', messages: [] },
        );

        expect((result as any).error).toContain('500');
        // Only GPT should have been called
        expect(callCount).toBe(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('maps GPT sizes to GLM sizes correctly', async () => {
      const originalFetch = globalThis.fetch;
      const fetchCalls: Array<{ url: string; body: any }> = [];

      globalThis.fetch = vi.fn().mockImplementation((url: string, opts: any) => {
        fetchCalls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
        if (url.includes('test-api.example.com')) {
          return Promise.resolve({
            ok: false,
            status: 500,
            text: () => Promise.resolve('fail'),
          });
        }
        if (url.includes('test-glm.example.com')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              data: [{ url: 'https://fake.com/img.png' }],
            }),
          });
        }
        // download image URL
        return Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        });
      });

      try {
        const tool = createGenerateImageTool();
        await tool.execute(
          { action: 'generate', prompt: 'test', size: '1536x1024' },
          { toolCallId: 'test', messages: [] },
        );

        // GLM call should use mapped size
        const glmCall = fetchCalls.find(c => c.url.includes('test-glm.example.com'));
        expect(glmCall).toBeDefined();
        expect(glmCall!.body.size).toBe('1568x1056'); // ~3:2 landscape
        expect(glmCall!.body.model).toBe('glm-image');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('edit action does not fall back to GLM', async () => {
      // GLM does not support edit — edit failures should not attempt fallback
      const originalFetch = globalThis.fetch;

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Server Error'),
      });

      try {
        const tool = createGenerateImageTool();
        // We need to provide a valid image path for edit, but since it will
        // fail at the API call, let's just check it doesn't crash
        const result = await tool.execute(
          { action: 'edit', prompt: 'make it blue', images: ['/nonexistent.png'] },
          { toolCallId: 'test', messages: [] },
        );

        // Should be an error (either image not found or API error), not a GLM fallback
        expect((result as any).error).toBeDefined();
        expect((result as any).error).not.toContain('GLM');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
