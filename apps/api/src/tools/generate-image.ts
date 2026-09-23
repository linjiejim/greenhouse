/**
 * Image Generation tool — generate and edit images with an OpenAI-compatible
 * image model (`IMAGE_MODEL`, default gpt-image-2).
 *
 * Actions:
 * - generate: render an image from a text prompt; with `images` attached, those
 *   images are composited in **as-is** (logos, product shots, reference art)
 * - edit: modify reference images according to the prompt
 *
 * One model, one channel, one quality tier: the image endpoint (`IMAGE_*`, else
 * the shared media endpoint — see ../media-provider.ts) at fixed `low` quality. The tier is not exposed to
 * callers — medium/high cost roughly 8x / 33x of low and the model has no way
 * to judge whether that spend is warranted. Need more detail? Raise `size`.
 *
 * Both actions hit the same upstream: with `images` present the request goes to
 * `/images/edits` (the only entry point that accepts reference images),
 * otherwise `/images/generations`. So "a new poster containing the real logo"
 * never has to masquerade as an edit — describing a logo for the model to
 * redraw only ever yields a forgery.
 */

import { tool } from 'ai';
import type { DatabaseProvider } from '@greenhouse/db';
import { estimateTokens } from '@greenhouse/agent-core';
import { toErrorMessage } from '@greenhouse/utils/error';
import { defineTool, type ToolMeta } from './define.js';
import { logger } from '@greenhouse/utils/logger';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { putUpload, getUpload, detectImageContentType } from '../storage/uploads.js';
import { fetchPublicImage } from '../security/network.js';
import { getImageProviderConfig } from '../llm/media-provider.js';
import { IMAGE_BUDGET_TTL_MS, reserveImageUsdBudget, settleAndRecordBudgetedImageUsage } from '../llm/usage-budget.js';

// ─── Upstream ────────────────────────────────────────────

/** The only model this tool speaks to (override with IMAGE_MODEL). */
const MODEL = process.env.IMAGE_MODEL || 'gpt-image-2';

/** The only quality tier this tool requests — see the module header. */
const QUALITY = 'low';

/** Default when the caller doesn't pick a size (3:2 landscape suits covers/blog headers). */
const DEFAULT_SIZE = '1536x1024';

/**
 * The only sizes gpt-image-2 actually renders. Anything else is NOT rejected upstream
 * and NOT snapped to a neighbour — it comes back at some other resolution entirely,
 * far heavier for no extra detail. Measured against the upstream at `low`:
 *
 *   asked 1024x1024 → got 1024x1024, 121KB, 196 output tokens
 *   asked 1080x1080 → got 1254x1254, 863KB, 229 output tokens
 *
 * So a plausible-looking "Instagram 1080x1080" silently produced a 7x heavier file at a
 * size nobody asked for. `resolveSize` snaps to this set instead.
 */
const SUPPORTED_SIZES = ['1024x1024', '1536x1024', '1024x1536'] as const;

/**
 * Per-image cost in USD at `low`, by size. The upstream bills image output at $30/1M tokens
 * and each tier emits a fixed token count, so a supported size is effectively a flat
 * price. Every key of SUPPORTED_SIZES must appear here.
 */
const COST_USD_BY_SIZE: Record<string, number> = {
  '1024x1024': 0.006,
  '1536x1024': 0.005,
  '1024x1536': 0.005,
};

/** Conservative image-token equivalents at low quality (rounded upward). */
const OUTPUT_TOKENS_BY_SIZE: Record<string, number> = {
  '1024x1024': 200,
  '1536x1024': 167,
  '1024x1536': 167,
};

/** Reference-image tokenization is provider opaque; reserve a safe bound each. */
const REFERENCE_IMAGE_TOKEN_ALLOWANCE = 10_000;

/**
 * Map any requested size onto a size the model actually renders, by closest aspect
 * ratio (log-distance, so 2:1 and 1:2 are equidistant from square).
 *
 * Snapping rather than erroring: the caller's real intent is the *shape* — "a square
 * social post", "a landscape header" — and the exact pixel count is incidental. An
 * error would just make the model guess again with no idea what is legal, while
 * silently forwarding the request gives an off-spec image. `auto` carries no aspect,
 * so it takes the default.
 */
export function resolveSize(requested: string | undefined): string {
  if (!requested || requested === 'auto') return DEFAULT_SIZE;
  if ((SUPPORTED_SIZES as readonly string[]).includes(requested)) return requested;

  const [w, h] = requested.split('x').map(Number);
  if (!w || !h) return DEFAULT_SIZE;
  const target = Math.log(w / h);
  return SUPPORTED_SIZES.reduce((best, candidate) => {
    const [cw, ch] = candidate.split('x').map(Number);
    const [bw, bh] = best.split('x').map(Number);
    return Math.abs(Math.log(cw / ch) - target) < Math.abs(Math.log(bw / bh) - target) ? candidate : best;
  });
}

/**
 * `low` renders in roughly 20–30s. The ceiling is generous enough for a slow upstream
 * but low enough that a wedged request fails before an MCP client's own call timeout.
 */
const REQUEST_TIMEOUT_MS = 180_000;

// ─── Helpers ─────────────────────────────────────────────

function generateFilename(contentType: string): string {
  const ext = contentType === 'image/jpeg' ? 'jpg' : contentType.slice('image/'.length);
  return `gen-${Date.now()}-${randomUUID()}.${ext}`;
}

/**
 * Materialize an API image response (b64_json or url) into a Buffer, persist it
 * to storage (COS `generate/` folder, or local disk), and return its flat id.
 *
 * Some upstreams return BOTH forms; taking base64 first is deliberate — it skips a
 * network hop, and hosted image URLs may be short-lived or unreachable from the
 * server's network.
 */
async function persistImage(imgData: { b64_json?: string; url?: string }): Promise<string> {
  let buffer: Buffer;
  let contentType: string;
  if (imgData.b64_json) {
    buffer = Buffer.from(imgData.b64_json, 'base64');
    contentType = detectImageContentType(buffer) ?? '';
  } else if (imgData.url) {
    const downloaded = await fetchPublicImage(imgData.url, { timeoutMs: 120_000 });
    buffer = downloaded.buffer;
    contentType = downloaded.contentType;
  } else {
    throw new Error(`Unknown image response format: ${Object.keys(imgData).join(', ')}`);
  }
  if (!contentType) throw new Error('Image API returned unsupported image bytes');
  const filename = generateFilename(contentType);
  await putUpload(filename, buffer, contentType);
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
  // Cap length to match the old REST relay (4000) so an unbounded prompt can't
  // run up upstream cost or trip provider limits.
  prompt: z.string().max(4000).describe('Image description for generation, or edit instruction for editing'),

  // generate params
  size: z
    .string()
    // "auto" or WxH digits only — reject free-form strings before they reach the
    // upstream API (bounds cost / avoids opaque provider errors).
    .regex(/^(auto|\d{1,4}x\d{1,4})$/, 'size must be "auto" or "<width>x<height>", e.g. "1536x1024"')
    .optional()
    .describe(
      'Image size — ONLY "1536x1024" (landscape, default), "1024x1536" (portrait) or "1024x1024" (square) are rendered as asked. ' +
        'Anything else (e.g. a platform spec like 1080x1080) is snapped to whichever of those three has the closest aspect ratio; ' +
        'pick by shape, not by a target pixel count.',
    ),
  // No `quality` knob by design — see the module header. Zod strips unknown keys, so
  // callers still passing `quality` from the old schema are silently served `low`
  // rather than erroring.

  // Reference assets. Usable with BOTH actions: on `edit` they are the images being
  // changed, on `generate` they are source material composited into a new image.
  images: z
    .array(z.string())
    .max(4)
    .optional()
    .describe(
      'Upload IDs or /api/upload/ URLs of reference images. Required for "edit". ' +
        'On "generate", these are composited into the new image and reproduced as-is — ' +
        'use this whenever the output must contain a real asset (logo, brand mark, product photo) ' +
        'instead of describing that asset in the prompt and letting the model redraw it.',
    ),
});

type GenerateImageInput = z.infer<typeof generateImageSchema>;

// ─── API Calls ───────────────────────────────────────────

/**
 * Post a generation request to the media endpoint and persist the returned image.
 * Throws on any upstream failure — there is no second provider to fall back to.
 */
interface ImageProviderResult {
  filename: string;
  usage?: { inputTokens: number; outputTokens: number };
}

function extractImageUsage(result: unknown): ImageProviderResult['usage'] {
  const usage = (result as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage) return undefined;
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0
  ) {
    return undefined;
  }
  return { inputTokens, outputTokens };
}

async function callGenerate(prompt: string, size: string, onProviderIo: () => void): Promise<ImageProviderResult> {
  const { apiKey, baseUrl } = getImageProviderConfig('image generation');

  onProviderIo();
  const resp = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      n: 1,
      size: size || DEFAULT_SIZE,
      quality: QUALITY,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const errorText = await resp.text().catch(() => 'unknown error');
    throw new Error(`Image generation API error ${resp.status}: ${errorText}`);
  }

  const result = (await resp.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
    usage?: Record<string, unknown>;
  };
  const image = result.data?.[0];
  if (!image) throw new Error('Image generation API returned no image');

  return { filename: await persistImage(image), usage: extractImageUsage(result) };
}

/**
 * Send one or more reference images plus a prompt to gpt-image-2 and persist the result.
 *
 * This is the only upstream entry point that accepts reference images, so it serves both
 * "edit this image" and "generate something new that contains this asset". The endpoint
 * honours `size` independently of the reference's own dimensions (verified: a 4218×1723
 * logo in, a 1024×1024 poster out), so callers must be able to set it — otherwise a
 * composition would inherit whatever shape the asset happened to be.
 */
async function callEdit(
  prompt: string,
  imagePaths: string[],
  size: string | undefined,
  onProviderIo: () => void,
): Promise<ImageProviderResult> {
  const { apiKey, baseUrl } = getImageProviderConfig('image editing');

  // Build multipart form data
  const formData = new FormData();
  formData.append('model', MODEL);
  formData.append('prompt', prompt);
  formData.append('quality', QUALITY);
  if (size) formData.append('size', size);

  for (const imgPath of imagePaths) {
    const { buffer, mime, filename } = await loadReferenceImage(imgPath);
    const blob = new Blob([new Uint8Array(buffer)], { type: mime });
    formData.append('image', blob, filename);
  }

  onProviderIo();
  const resp = await fetch(`${baseUrl}/images/edits`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const errorText = await resp.text().catch(() => 'unknown error');
    throw new Error(`Image edit API error ${resp.status}: ${errorText}`);
  }

  const result = (await resp.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
    usage?: Record<string, unknown>;
  };
  const image = result.data?.[0];
  if (!image) throw new Error('Image edit API returned no image');

  return { filename: await persistImage(image), usage: extractImageUsage(result) };
}

// ─── Tool Factory ────────────────────────────────────────

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'generate_image',
  name: 'Image Generation',
  brief: 'Generate images from text descriptions',
  description: `Generate or edit images using the GPT-Image-2 model.
Use this ONLY when the user explicitly asks to create, generate, design, or edit an image, illustration, picture, poster, or banner.
Images render at a fixed cost-efficient quality; if the result looks soft, ask for a larger size rather than a different quality.

IMPORTANT — never describe a logo, brand mark, or other fixed asset in the prompt and let the model draw it: it will invent a lookalike, which brand guidelines forbid. Instead pass the real file in \`images\` (works with action "generate" too) and instruct the model to place it unchanged. Brand assets live in the knowledge base — e.g. the doc "brand/foundations/logo" embeds the logo lockup and mark as /api/upload/<id> links; read the doc first and pass those IDs here.

MARKED-UP REVISIONS — given an original plus a copy carrying the user's drawn marks, use action "edit" and pass BOTH in \`images\`, clean original FIRST — edits build on the first image, so leading with the marked copy bakes the ink in. Marks say WHERE; the text says WHAT. Never redraw the marks.`,
  category: 'team',
  is_global: true,
  icon: 'Palette',
  // Reachable through the /api/agent proxy and /api/mcp server as a read-tool
  // (generation has cost but mutates no domain data — no confirm gate). This is
  // how image skills generate images; is_global means every internal
  // user already holds it, so it appears for all super/team MCP clients.
  surface: { proxy: 'read', mcp: 'image' },
  runtime_risk: 'r1',
  sort_order: 12,
  presentation: 'artifact', // generated image renders inline in the message body
};

export interface GenerateImageToolContext {
  db: DatabaseProvider;
  userId: string;
  sessionId?: string;
}

function estimateImageTokens(prompt: string, size: string | undefined, referenceCount: number): number {
  const outputTokens = OUTPUT_TOKENS_BY_SIZE[size ?? DEFAULT_SIZE] ?? OUTPUT_TOKENS_BY_SIZE['1024x1024'];
  return Math.max(1, estimateTokens(prompt) + outputTokens + referenceCount * REFERENCE_IMAGE_TOKEN_ALLOWANCE);
}

function imageCostUsdMicros(size: string | undefined): number {
  // An edit without an explicit size preserves the source aspect ratio, which
  // the control plane cannot know before provider I/O. Reserve/settle the most
  // expensive supported shape so an unknown square source can never exceed a
  // hard USD budget (the runner still reports the actual rendered asset).
  const cost = size
    ? (COST_USD_BY_SIZE[size] ?? COST_USD_BY_SIZE[DEFAULT_SIZE])
    : Math.max(...Object.values(COST_USD_BY_SIZE));
  return Math.ceil(cost * 1_000_000);
}

export function createGenerateImageTool(ctx: GenerateImageToolContext) {
  return tool({
    description: meta.description,
    inputSchema: generateImageSchema,
    execute: async (input: GenerateImageInput, options) => {
      try {
        switch (input.action) {
          case 'generate': {
            if (!input.prompt) {
              return { error: 'prompt is required for generate' };
            }
            const size = resolveSize(input.size);
            const snapped = input.size && input.size !== size;
            // Reference assets force the edits endpoint — it is the only one that
            // accepts them (see callEdit).
            const refs = input.images ?? [];
            logger.info(
              `[GenerateImage] 🎨 Generating: "${input.prompt.slice(0, 80)}..." size=${size} quality=${QUALITY}` +
                (snapped ? ` (snapped from ${input.size})` : '') +
                (refs.length ? ` refs=${refs.length}` : ''),
            );
            const estimatedTokens = estimateImageTokens(input.prompt, size, refs.length);
            const estimatedUsdMicros = imageCostUsdMicros(size);
            const budget = await reserveImageUsdBudget({
              db: ctx.db,
              userId: ctx.userId,
              caller: 'generate-image',
              estimatedUsdMicros,
              modelId: MODEL,
              providerId: 'media',
              runId: ctx.sessionId,
              // A replayed business toolCallId performs fresh provider I/O —
              // there is no cached image result — so every attempt needs a new
              // accounting key rather than silently reusing an old settlement.
              idempotencyKey: `generate-image:${ctx.userId}:${options.toolCallId.slice(0, 120)}:${randomUUID()}`,
              ttlMs: IMAGE_BUDGET_TTL_MS,
              metadata: { action: input.action, size, reference_count: refs.length },
            });
            let providerResult: ImageProviderResult;
            try {
              providerResult = refs.length
                ? await callEdit(input.prompt, refs, size, () => budget.markProviderIoStarted())
                : await callGenerate(input.prompt, size, () => budget.markProviderIoStarted());
            } catch (err) {
              await budget.releaseBeforeProviderIo('image_preflight_failed').catch(() => {});
              throw err;
            }
            const filename = providerResult.filename;
            const actualInput = providerResult.usage?.inputTokens ?? 0;
            const actualOutput = providerResult.usage?.outputTokens ?? estimatedTokens;
            await settleAndRecordBudgetedImageUsage(ctx.db, budget, estimatedUsdMicros, {
              profile_id: 'image',
              caller: 'generate-image',
              session_id: ctx.sessionId,
              user_id: ctx.userId,
              model: MODEL,
              input_tokens: actualInput,
              output_tokens: actualOutput,
            }).catch((err) => {
              logger.warn('[GenerateImage] failed to settle budgeted usage', {
                budgetKey: budget.idempotencyKey,
                error: String(err),
              });
            });
            logger.info(`[GenerateImage] ✅ Saved: ${filename} (model: ${MODEL})`);
            const imageUrl = `/api/upload/${filename}`;
            return {
              success: true,
              url: imageUrl,
              markdown: `![Generated Image](${imageUrl})`,
              filename,
              model: MODEL,
              size,
              quality: QUALITY,
              estimated_cost_usd: COST_USD_BY_SIZE[size],
              prompt: input.prompt,
              // Surface the snap so an unsupported request isn't invisibly rewritten.
              ...(snapped ? { requested_size: input.size } : {}),
              ...(refs.length ? { reference_images: refs } : {}),
            };
          }

          case 'edit': {
            if (!input.prompt) {
              return { error: 'prompt is required for edit' };
            }
            if (!input.images || input.images.length === 0) {
              return {
                error:
                  'At least one reference image is required for edit. Pass upload IDs or /api/upload/ URLs — ' +
                  'they can come from a user upload or from an existing asset (e.g. a logo embedded in a knowledge-base doc).',
              };
            }
            // Omitted size stays omitted: a plain edit should keep the source's shape,
            // which is what the upstream does by default. A stated size is still snapped.
            const editSize = input.size ? resolveSize(input.size) : undefined;
            logger.info(
              `[GenerateImage] ✏️ Editing ${input.images.length} image(s): "${input.prompt.slice(0, 80)}..."` +
                (editSize ? ` size=${editSize}` : ''),
            );
            const estimatedTokens = estimateImageTokens(input.prompt, editSize, input.images.length);
            const estimatedUsdMicros = imageCostUsdMicros(editSize);
            const budget = await reserveImageUsdBudget({
              db: ctx.db,
              userId: ctx.userId,
              caller: 'generate-image',
              estimatedUsdMicros,
              modelId: MODEL,
              providerId: 'media',
              runId: ctx.sessionId,
              idempotencyKey: `generate-image:${ctx.userId}:${options.toolCallId.slice(0, 120)}:${randomUUID()}`,
              ttlMs: IMAGE_BUDGET_TTL_MS,
              metadata: { action: input.action, size: editSize, reference_count: input.images.length },
            });
            let providerResult: ImageProviderResult;
            try {
              providerResult = await callEdit(input.prompt, input.images, editSize, () =>
                budget.markProviderIoStarted(),
              );
            } catch (err) {
              await budget.releaseBeforeProviderIo('image_preflight_failed').catch(() => {});
              throw err;
            }
            const filename = providerResult.filename;
            await settleAndRecordBudgetedImageUsage(ctx.db, budget, estimatedUsdMicros, {
              profile_id: 'image',
              caller: 'generate-image',
              session_id: ctx.sessionId,
              user_id: ctx.userId,
              model: MODEL,
              input_tokens: providerResult.usage?.inputTokens ?? 0,
              output_tokens: providerResult.usage?.outputTokens ?? estimatedTokens,
            }).catch((err) => {
              logger.warn('[GenerateImage] failed to settle budgeted usage', {
                budgetKey: budget.idempotencyKey,
                error: String(err),
              });
            });
            logger.info(`[GenerateImage] ✅ Edited & saved: ${filename}`);
            const imageUrl = `/api/upload/${filename}`;
            return {
              success: true,
              url: imageUrl,
              markdown: `![Edited Image](${imageUrl})`,
              filename,
              model: MODEL,
              quality: QUALITY,
              prompt: input.prompt,
              reference_images: input.images,
              ...(editSize ? { size: editSize } : {}),
              ...(input.size && input.size !== editSize ? { requested_size: input.size } : {}),
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

export const generateImageTool = defineTool({ meta, kind: 'lazy' });
