/**
 * Image adapters (docs/product/providers.md §6). The OpenAI Images API, asked for base64 so the
 * bytes arrive with the response: following a hosted image URL would mean fetching from an
 * origin the instance was never pinned to.
 */

import { z } from 'zod';
import type { GeneratedImage, ImageClient, ProviderAdapter } from '../types.js';
import { ProviderRequestError, bearer, hostOf, postJson, withoutTrailingSlash, type CallContext } from '../http.js';

/** Low-quality renders take 20–30 s; a wedged request still fails before a client gives up. */
const IMAGE_TIMEOUT_MS = 180_000;

const imageConfigSchema = z.object({
  baseUrl: z.string().url(),
  model: z.string().min(1),
  /** Used when a request names no size, e.g. 1024x1024; unset leaves it to the vendor. */
  size: z
    .string()
    .regex(/^(auto|\d{2,5}x\d{2,5})$/)
    .optional(),
  /** Sent as quality when set. GPT image models cost far more at medium and high than at low. */
  quality: z.string().min(1).optional(),
});
type ImageConfig = z.infer<typeof imageConfigSchema>;

interface ImagesResponse {
  data?: { b64_json?: string; url?: string }[];
}

/** GPT image models always answer in base64 and reject response_format; other models are asked for it. */
const alwaysBase64 = (model: string) => /^(gpt-image|chatgpt-image)/i.test(model);

const startsWith = (bytes: Uint8Array, offset: number, signature: string) =>
  [...signature].every((char, index) => bytes[offset + index] === char.charCodeAt(0));

function imageTypeOf(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0x89 && startsWith(bytes, 1, 'PNG')) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (startsWith(bytes, 0, 'RIFF') && startsWith(bytes, 8, 'WEBP')) return 'image/webp';
  if (startsWith(bytes, 0, 'GIF8')) return 'image/gif';
  return undefined;
}

function decode(item: { b64_json?: string; url?: string }, call: CallContext): GeneratedImage {
  if (!item.b64_json) {
    throw new ProviderRequestError(
      item.url
        ? `${call.label} returned an image URL instead of base64 data; use a model or vendor that returns b64_json.`
        : `${call.label} returned an image without data.`,
    );
  }
  const bytes = Buffer.from(item.b64_json, 'base64');
  const data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mimeType = imageTypeOf(data);
  if (!mimeType) throw new ProviderRequestError(`${call.label} returned data that is not a PNG, JPEG, WebP or GIF.`);
  return { data, mimeType };
}

/** Image APIs have no free call: one image at the instance's own size is the cheapest proof. */
async function probe(client: ImageClient, config: ImageConfig) {
  await client.generate({ prompt: 'A small green sprout on a plain background', size: config.size ?? '1024x1024' });
}

export const openaiCompatibleImageAdapter: ProviderAdapter<'image', ImageConfig> = {
  capability: 'image',
  kind: 'openai-compatible',
  label: 'OpenAI 兼容',
  configSchema: imageConfigSchema as z.ZodType<ImageConfig>,
  secretKeys: ['apiKey'],
  // Local servers may take no key.
  requiredSecrets: [],
  presets: [
    {
      id: 'openai',
      label: 'OpenAI',
      config: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-2', quality: 'low' },
    },
  ],
  endpoints: (config) => [config.baseUrl],
  create: ({ config, secrets, fetch }) => {
    const call: CallContext = {
      label: `${hostOf(config.baseUrl)} image generation`,
      secrets: [secrets.apiKey],
      timeoutMs: IMAGE_TIMEOUT_MS,
    };
    return {
      async generate(input) {
        const size = input.size ?? config.size;
        const payload = {
          model: config.model,
          prompt: input.prompt,
          n: Math.min(Math.max(Math.trunc(input.n ?? 1) || 1, 1), 10),
          ...(size ? { size } : {}),
          ...(config.quality ? { quality: config.quality } : {}),
          ...(alwaysBase64(config.model) ? {} : { response_format: 'b64_json' }),
        };
        const body = await postJson<ImagesResponse>(
          fetch,
          `${withoutTrailingSlash(config.baseUrl)}/images/generations`,
          payload,
          bearer(secrets.apiKey),
          call,
        );
        const items = Array.isArray(body.data) ? body.data : [];
        if (!items.length) throw new ProviderRequestError(`${call.label} returned no image.`);
        return { images: items.map((item) => decode(item, call)) };
      },
    };
  },
  test: probe,
  testTimeoutMs: IMAGE_TIMEOUT_MS,
};

export const IMAGE_ADAPTERS = [openaiCompatibleImageAdapter];
