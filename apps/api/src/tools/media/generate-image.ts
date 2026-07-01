/**
 * Image Generation tool — generate and edit images via an OpenAI-compatible
 * image API, with an optional secondary provider as fallback.
 *
 * Actions:
 * - generate: create an image from a text prompt (primary provider, falling back
 *             to the secondary provider on failure when it is configured)
 * - edit: edit an image from a reference image + prompt (primary provider only)
 *
 * Both providers are env-configured (no hardcoded hosts):
 *   GPT_IMAGE_API_KEY / GPT_IMAGE_BASE_URL — primary image API (OpenAI-compatible)
 *   GLM_IMAGE_API_KEY / GLM_IMAGE_BASE_URL — optional fallback image API
 */

import { tool } from 'ai';
import { toErrorMessage } from '@greenhouse/utils/error';
import { defineTool, type ToolMeta } from '../define.js';
import { logger } from '@greenhouse/utils/logger';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { putUpload, getUpload } from '../../storage/uploads.js';

// ─── Config from env ─────────────────────────────────────

function getGptConfig() {
  const apiKey = process.env.GPT_IMAGE_API_KEY;
  const baseUrl = process.env.GPT_IMAGE_BASE_URL;
  if (!apiKey || !baseUrl) {
    throw new Error('GPT_IMAGE_API_KEY and GPT_IMAGE_BASE_URL must be set to enable image generation');
  }
  return { apiKey, baseUrl };
}

function getGlmConfig() {
  const apiKey = process.env.GLM_IMAGE_API_KEY;
  const baseUrl = process.env.GLM_IMAGE_BASE_URL;
  if (!apiKey || !baseUrl) {
    throw new Error('GLM_IMAGE_API_KEY and GLM_IMAGE_BASE_URL must be set to enable the image fallback');
  }
  return { apiKey, baseUrl };
}

// ─── GLM Size Mapping ────────────────────────────────────

/** GLM recommended sizes with their aspect ratios */
const GLM_SIZES: Array<{ w: number; h: number; label: string }> = [
  { w: 1280, h: 1280, label: '1280x1280' }, // 1:1
  { w: 1568, h: 1056, label: '1568x1056' }, // ~3:2 landscape
  { w: 1056, h: 1568, label: '1056x1568' }, // ~2:3 portrait
  { w: 1472, h: 1088, label: '1472x1088' }, // ~4:3 landscape
  { w: 1088, h: 1472, label: '1088x1472' }, // ~3:4 portrait
  { w: 1728, h: 960, label: '1728x960' }, // ~16:9 landscape
  { w: 960, h: 1728, label: '960x1728' }, // ~9:16 portrait
];

/**
 * Map a GPT-Image-2 size string to the closest GLM recommended size.
 * Falls back to 1280x1280 for 'auto' or unparseable sizes.
 */
function mapSizeToGlm(gptSize?: string): string {
  if (!gptSize || gptSize === 'auto') return '1280x1280';

  const match = gptSize.match(/^(\d+)x(\d+)$/);
  if (!match) return '1280x1280';

  const tw = parseInt(match[1], 10);
  const th = parseInt(match[2], 10);
  const targetRatio = tw / th;

  // Find closest aspect ratio match
  let best = GLM_SIZES[0];
  let bestDiff = Infinity;
  for (const s of GLM_SIZES) {
    const diff = Math.abs(s.w / s.h - targetRatio);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = s;
    }
  }
  return best.label;
}

// ─── Helpers ─────────────────────────────────────────────

function generateFilename(): string {
  return `gen-${Date.now()}-${randomUUID().slice(0, 8)}.png`;
}

/**
 * Materialize an API image response (b64_json or url) into a Buffer, persist it
 * to storage (COS `generate/` folder, or local disk), and return its flat id.
 */
async function persistImage(imgData: { b64_json?: string; url?: string }): Promise<string> {
  let buffer: Buffer;
  if (imgData.b64_json) {
    buffer = Buffer.from(imgData.b64_json, 'base64');
  } else if (imgData.url) {
    const resp = await fetch(imgData.url, { signal: AbortSignal.timeout(120_000) });
    if (!resp.ok) throw new Error(`Failed to download image: ${resp.status}`);
    buffer = Buffer.from(await resp.arrayBuffer());
  } else {
    throw new Error(`Unknown image response format: ${Object.keys(imgData).join(', ')}`);
  }
  const filename = generateFilename();
  await putUpload(filename, buffer, 'image/png');
  return filename;
}

/**
 * Load a reference image (for edit) by upload id or /api/upload/ URL, from
 * storage (COS with local-disk fallback). Throws if it doesn't exist.
 */
async function loadReferenceImage(ref: string): Promise<{ buffer: Buffer; mime: string; filename: string }> {
  const id = ref.replace(/^\/api\/upload\//, '');
  const stored = await getUpload(id);
  if (!stored) throw new Error(`Image not found: ${ref}`);
  const mime = stored.contentType.startsWith('image/') ? stored.contentType : 'image/png';
  return { buffer: stored.buffer, mime, filename: basename(id) };
}

// ─── Tool Schema ─────────────────────────────────────────

const generateImageSchema = z.object({
  action: z.enum(['generate', 'edit']).describe('Action: generate a new image or edit an existing one'),
  prompt: z.string().describe('Image description for generation, or edit instruction for editing'),

  // generate params
  size: z
    .string()
    .optional()
    .describe(
      'Image size. Common: "1536x1024" (landscape, default), "1024x1536" (portrait), "1024x1024" (square), "auto". Must be multiples of 16, max 3840px, ratio max 3:1',
    ),
  quality: z
    .enum(['low', 'medium', 'high'])
    .optional()
    .describe('Image quality (default: high). Lower quality is faster.'),

  // edit params
  images: z
    .array(z.string())
    .optional()
    .describe('Reference image paths or upload IDs for editing. Required for edit action.'),
});

type GenerateImageInput = z.infer<typeof generateImageSchema>;

// ─── API Calls ───────────────────────────────────────────

/** Result from a generation call, includes model info for fallback tracking. */
interface GenerateResult {
  filename: string;
  model: string;
  fallback: boolean;
}

/** Call GPT-Image-2 API directly (throws on failure). */
async function callGptGenerate(prompt: string, size?: string, quality?: string): Promise<string> {
  const { apiKey, baseUrl } = getGptConfig();
  const url = `${baseUrl}/images/generations`;

  const payload: Record<string, unknown> = {
    model: 'gpt-image-2',
    prompt,
    n: 1,
    size: size || '1536x1024',
    quality: quality || 'high',
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(300_000), // 5 min timeout
  });

  if (!resp.ok) {
    const errorText = await resp.text().catch(() => 'unknown error');
    throw new Error(`GPT Image generation API error ${resp.status}: ${errorText}`);
  }

  const result = (await resp.json()) as { data: Array<{ b64_json?: string; url?: string }> };

  const filename = await persistImage(result.data[0]);
  return filename;
}

/** Call GLM-Image API (throws on failure). */
async function callGlmGenerate(prompt: string, size?: string): Promise<string> {
  const { apiKey, baseUrl } = getGlmConfig();
  const url = `${baseUrl}/images/generations`;

  // GLM prompt limit: 1000 chars
  const truncatedPrompt = prompt.length > 1000 ? prompt.slice(0, 1000) : prompt;
  const glmSize = mapSizeToGlm(size);

  const payload: Record<string, unknown> = {
    model: 'glm-image',
    prompt: truncatedPrompt,
    size: glmSize,
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000), // 2 min timeout (GLM is faster)
  });

  if (!resp.ok) {
    const errorText = await resp.text().catch(() => 'unknown error');
    throw new Error(`GLM Image generation API error ${resp.status}: ${errorText}`);
  }

  const result = (await resp.json()) as { data: Array<{ url?: string }> };

  if (!result.data?.[0]?.url) {
    throw new Error('GLM Image API returned no image URL');
  }

  const filename = await persistImage(result.data[0]);
  return filename;
}

/**
 * Generate an image with GPT-Image-2, falling back to GLM-Image on failure.
 * Fallback only triggers when GLM_IMAGE_API_KEY is configured.
 */
async function callGenerate(prompt: string, size?: string, quality?: string): Promise<GenerateResult> {
  // Try GPT-Image-2 first
  try {
    const filename = await callGptGenerate(prompt, size, quality);
    return { filename, model: 'gpt-image-2', fallback: false };
  } catch (gptErr) {
    const gptMsg = toErrorMessage(gptErr);
    logger.warn(`[GenerateImage] ⚠️ GPT-Image-2 failed: ${gptMsg}`);

    // Check if the fallback provider is available
    if (!process.env.GLM_IMAGE_API_KEY || !process.env.GLM_IMAGE_BASE_URL) {
      throw gptErr; // No fallback configured, re-throw original
    }

    // Try GLM-Image fallback
    logger.info(`[GenerateImage] 🔄 Falling back to GLM-Image...`);
    try {
      const filename = await callGlmGenerate(prompt, size);
      logger.info(`[GenerateImage] ✅ GLM-Image fallback succeeded: ${filename}`);
      return { filename, model: 'glm-image', fallback: true };
    } catch (glmErr) {
      const glmMsg = toErrorMessage(glmErr);
      logger.error(`[GenerateImage] ❌ GLM-Image fallback also failed: ${glmMsg}`);
      // Throw combined error with both failure details
      throw new Error(`Image generation failed. GPT-Image-2: ${gptMsg} | GLM-Image fallback: ${glmMsg}`);
    }
  }
}

async function callEdit(prompt: string, imagePaths: string[]): Promise<string> {
  const { apiKey, baseUrl } = getGptConfig();
  const url = `${baseUrl}/images/edits`;

  // Build multipart form data
  const formData = new FormData();
  formData.append('model', 'gpt-image-2');
  formData.append('prompt', prompt);

  for (const imgPath of imagePaths) {
    const { buffer, mime, filename } = await loadReferenceImage(imgPath);
    const blob = new Blob([new Uint8Array(buffer)], { type: mime });
    formData.append('image', blob, filename);
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
    signal: AbortSignal.timeout(300_000),
  });

  if (!resp.ok) {
    const errorText = await resp.text().catch(() => 'unknown error');
    throw new Error(`Image edit API error ${resp.status}: ${errorText}`);
  }

  const result = (await resp.json()) as { data: Array<{ b64_json?: string; url?: string }> };

  const filename = await persistImage(result.data[0]);
  return filename;
}

// ─── Tool Factory ────────────────────────────────────────

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'generate_image',
  name: 'Image Generation',
  brief: 'Generate images from text descriptions',
  description: `Generate or edit images using GPT-Image-2 AI model.
Use this ONLY when the user explicitly asks to create, generate, design, or edit an image, illustration, picture, poster, or banner.
Supports creating images from text descriptions and editing existing uploaded images.
Suitable for product concept art, blog illustrations, social media assets, etc.`,
  category: 'team',
  is_global: true,
  icon: 'Palette',
  group: 'media',
  presentation: 'artifact', // generated image renders inline in the message body
};

export function createGenerateImageTool() {
  return tool({
    description: meta.description,
    inputSchema: generateImageSchema,
    execute: async (input: GenerateImageInput) => {
      try {
        switch (input.action) {
          case 'generate': {
            if (!input.prompt) {
              return { error: 'prompt is required for generate' };
            }
            logger.info(
              `[GenerateImage] 🎨 Generating: "${input.prompt.slice(0, 80)}..." size=${input.size || '1536x1024'} quality=${input.quality || 'high'}`,
            );
            const result = await callGenerate(input.prompt, input.size, input.quality);
            logger.info(
              `[GenerateImage] ✅ Saved: ${result.filename} (model: ${result.model}${result.fallback ? ', fallback' : ''})`,
            );
            const imageUrl = `/api/upload/${result.filename}`;
            return {
              success: true,
              url: imageUrl,
              markdown: `![Generated Image](${imageUrl})`,
              filename: result.filename,
              model: result.model,
              fallback: result.fallback,
              size: input.size || '1536x1024',
              quality: input.quality || 'high',
              prompt: input.prompt,
            };
          }

          case 'edit': {
            if (!input.prompt) {
              return { error: 'prompt is required for edit' };
            }
            if (!input.images || input.images.length === 0) {
              return {
                error: 'At least one reference image is required for edit. The user must upload an image first.',
              };
            }
            logger.info(
              `[GenerateImage] ✏️ Editing ${input.images.length} image(s): "${input.prompt.slice(0, 80)}..."`,
            );
            const filename = await callEdit(input.prompt, input.images);
            logger.info(`[GenerateImage] ✅ Edited & saved: ${filename}`);
            const imageUrl = `/api/upload/${filename}`;
            return {
              success: true,
              url: imageUrl,
              markdown: `![Edited Image](${imageUrl})`,
              filename,
              model: 'gpt-image-2',
              prompt: input.prompt,
              reference_images: input.images,
            };
          }

          default:
            return { error: `Unknown action: ${input.action}` };
        }
      } catch (err) {
        const message = toErrorMessage(err);
        logger.error(`[GenerateImage] ❌ Error: ${message}`);
        return { error: `Image generation error: ${message}` };
      }
    },
  });
}

export const generateImageTool = defineTool({ meta, kind: 'static', create: () => createGenerateImageTool() });
