/** OpenAI-compatible asynchronous videos, including 302.AI's official-format endpoint. */
import { z } from 'zod';
import type { ProviderAdapter, VideoState } from '../types.js';
import {
  bearer,
  getJson,
  postJson,
  readJson,
  redact,
  send,
  withoutTrailingSlash,
  ProviderRequestError,
} from '../http.js';
import { readCapped } from '../mail/shared.js';

const configSchema = z.object({
  baseUrl: z.string().url(),
  model: z.string().min(1),
  size: z.enum(['1280x720', '720x1280', '1792x1024', '1024x1792']).default('1280x720'),
  /** Explicit download origins; keys never accompany requests to them. */
  contentOrigins: z.array(z.string().url()).max(8).default([]),
});
type Config = z.infer<typeof configSchema>;
const stateSchema = z.object({
  id: z.string().min(1).max(200),
  status: z.enum(['queued', 'in_progress', 'completed', 'failed']),
  progress: z.number().min(0).max(100).default(0),
  error: z.unknown().optional(),
});
const MAX_BYTES = 50 * 1024 * 1024;
export const openaiCompatibleVideoAdapter: ProviderAdapter<'video', Config> = {
  capability: 'video',
  kind: 'openai-compatible',
  label: 'OpenAI 兼容',
  configSchema,
  secretKeys: ['apiKey'],
  requiredSecrets: ['apiKey'],
  presets: [
    {
      id: '302ai',
      label: '302.AI',
      config: { baseUrl: 'https://api.302.ai/openai/v1', model: 'sora-2', contentOrigins: ['https://file.302.ai'] },
      docsUrl: 'https://doc.302.ai/358575764e0',
    },
  ],
  endpoints: (config) => [config.baseUrl, ...config.contentOrigins],
  create: ({ config, secrets, fetch }) => {
    const base = withoutTrailingSlash(config.baseUrl);
    const call = { label: 'Video service', secrets: [secrets.apiKey], timeoutMs: 60000 };
    const state = (raw: unknown): VideoState => {
      const result = stateSchema.safeParse(raw);
      if (!result.success) throw new ProviderRequestError('Video service returned an invalid job state.');
      return {
        id: result.data.id,
        status: result.data.status,
        progress: result.data.progress,
        ...(result.data.error ? { error: redact('Video generation failed.', [secrets.apiKey]) } : {}),
      };
    };
    return {
      async create(input) {
        return state(
          await postJson(
            fetch,
            `${base}/videos`,
            { model: config.model, prompt: input.prompt, seconds: input.seconds, size: input.size ?? config.size },
            bearer(secrets.apiKey),
            call,
          ),
        );
      },
      async retrieve(id) {
        return state(await getJson(fetch, `${base}/videos/${encodeURIComponent(id)}`, bearer(secrets.apiKey), call));
      },
      async content(id) {
        let response = await send(
          fetch,
          `${base}/videos/${encodeURIComponent(id)}/content`,
          { headers: bearer(secrets.apiKey) },
          call,
        );
        if (response.headers.get('content-type')?.includes('application/json')) {
          const body = await readJson<{ url?: unknown }>(response, call);
          if (typeof body.url !== 'string') throw new ProviderRequestError('Video service returned no content URL.');
          response = await send(fetch, body.url, { headers: {} }, call);
        }
        const data = await readCapped(response, MAX_BYTES);
        if (!data) throw new ProviderRequestError('Videos can be up to 50 MB.');
        if (data.length < 12 || new TextDecoder().decode(data.slice(4, 8)) !== 'ftyp')
          throw new ProviderRequestError('Video service returned content that is not MP4.');
        return { data, mimeType: 'video/mp4' };
      },
    };
  },
  // Check credentials without buying a render. An unknown id must answer 404, rather than 401.
  test: async (client) => {
    try {
      await client.retrieve('greenhouse-connection-check');
    } catch (error) {
      if (!(error instanceof ProviderRequestError) || error.statusCode !== 404) throw error;
    }
  },
};
