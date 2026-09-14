/**
 * analyze_image tool — understand uploaded images with a multimodal model.
 *
 * Uses the OpenAI-compatible media endpoint (see ../media-provider.ts) with
 * `VISION_MODEL`. Called by the main LLM when the user attaches an image to
 * their message and the chat model itself cannot see images.
 *
 * Supports two input modes:
 *   1. Stored upload ID — resolves through the shared storage abstraction
 *   2. Public HTTPS URL — bounded download with DNS/redirect SSRF checks
 *
 * Built per authenticated request so provider usage is charged to its owner.
 * Provider configuration still comes from environment variables:
 *   MEDIA_API_KEY / MEDIA_BASE_URL — shared media upstream (falls back to LLM_*), see ../media-provider.ts
 *   VISION_MODEL                   — multimodal model id (default: gpt-4o-mini)
 */

import { tool, generateText } from 'ai';
import { toErrorMessage } from '@greenhouse/utils/error';
import { defineTool, type ToolMeta } from './define.js';
import { logger } from '@greenhouse/utils/logger';
import { z } from 'zod';
import type { DatabaseProvider } from '@greenhouse/db';
import { getUpload, isValidUploadId } from '../storage/uploads.js';
import { normalizeFileRef, resolveConversationFiles } from '../files/conversation-files.js';
import { fetchPublicImage } from '../security/network.js';
import { getMediaProviderConfig } from '../llm/media-provider.js';
import { reserveUserTokenBudget, settleAndRecordBudgetedUsage } from '../llm/usage-budget.js';

const VISION_PROMPT = `Analyze the attached image as neutral source material. Do not assume it is about plants, products, support, or any other domain.

First identify the likely content type (for example: screenshot, email, document, chart, interface, product photo, plant photo, or general scene). Then extract the information that is most useful for the user's request:
1. **Primary content**: the main subject, purpose, state, or event shown
2. **Important details**: readable text, names, dates, numbers, links, labels, statuses, errors, and calls to action
3. **Structure and relationships**: sections, hierarchy, sequence, comparisons, or connections that affect meaning
4. **Notable visual evidence**: conditions, anomalies, trends, or details that are relevant but easy to miss

For screenshots, emails, and documents, prioritize faithful extraction and concise synthesis over visual description. For photos, describe only details that materially help. Clearly separate visible facts from inference, flag uncertainty, and never invent unreadable text or hidden context.

User's request: {question}

Answer the user's request directly when it is specific. Otherwise provide a concise, structured summary of the most important information. Respond in English.`;

export function buildVisionPrompt(question?: string): string {
  return VISION_PROMPT.replace(
    '{question}',
    question?.trim() || 'Extract the most important information from this image',
  );
}

export const MAX_VISION_QUESTION_CHARS = 8 * 1024;

export const analyzeImageSchema = z.object({
  image_id: z.string().describe('The uploaded image ID or a public HTTPS image URL to analyze'),
  question: z
    .string()
    .max(MAX_VISION_QUESTION_CHARS, `Question must not exceed ${MAX_VISION_QUESTION_CHARS} characters`)
    .optional()
    .describe('Specific question about the image from the user'),
});

type AnalyzeImageInput = z.infer<typeof analyzeImageSchema>;

const VISION_MAX_OUTPUT_TOKENS = 1_200;
// Retries stay at zero until each concrete provider attempt has its own
// reservation/settlement hook. A timed-out billable first request must never
// be hidden behind one successful aggregate settlement.
const VISION_MAX_RETRIES = 0;
/** Conservative per-attempt allowance for provider-side image tokenization. */
const VISION_IMAGE_TOKEN_ALLOWANCE = 32_768;

/**
 * Tokenizer-independent admission upper bound. UTF-8 bytes safely dominate
 * the number of byte-backed input tokens even for high-entropy/non-Latin text,
 * while the image and output allowances cover provider-side tokenization.
 */
export function estimateVisionRequestTokens(question?: string): number {
  const prompt = buildVisionPrompt(question);
  const inputBytes = Buffer.byteLength(
    JSON.stringify([{ role: 'user', content: [{ type: 'text', text: prompt }] }]),
    'utf8',
  );
  return (Math.max(1, inputBytes) + VISION_MAX_OUTPUT_TOKENS + VISION_IMAGE_TOKEN_ALLOWANCE) * (VISION_MAX_RETRIES + 1);
}

/**
 * Create the vision model client on the media endpoint.
 * Uses lazy dynamic import of @ai-sdk/openai.
 */
async function createVisionModel() {
  const { apiKey, baseUrl } = getMediaProviderConfig('image analysis');
  const modelId = process.env.VISION_MODEL || 'gpt-4o-mini';
  const { createOpenAI } = await import('@ai-sdk/openai');
  const client = createOpenAI({
    apiKey,
    baseURL: baseUrl,
  });
  return { model: client.chat(modelId), modelId };
}

type PreparedVisionModel = Awaited<ReturnType<typeof createVisionModel>>;

interface LoadedImage {
  buffer: Buffer;
  contentType: string;
}

/**
 * What the reference the model gave us turned out to be.
 *
 * `not_an_image` is a distinct outcome rather than a miss because the two need
 * opposite advice: a miss means "that id resolves nowhere", while a resolved
 * non-image means the conversation really does own the file and the model
 * should stop looking for a better id.
 */
type ImageResolution =
  | { kind: 'loaded'; image: LoadedImage }
  | { kind: 'missing' }
  | { kind: 'not_an_image'; name: string; contentType: string };

/**
 * Read the flat image store, without letting a non-upload id reach it.
 *
 * `getUpload` THROWS "Invalid upload ID" for anything outside its id shape, and
 * a `chat_files` id is a bare UUID — so an attachment id surfaced to the model
 * as "Failed to load image: Invalid upload ID", a dead end for a file sitting
 * in the conversation. Guard first, same order as `resolveConversationFiles`.
 */
async function loadStoredImage(ref: string): Promise<LoadedImage | null> {
  if (!isValidUploadId(ref)) return null;
  const stored = await getUpload(ref);
  return stored ? { buffer: stored.buffer, contentType: stored.contentType } : null;
}

async function resolveImage(ctx: AnalyzeImageContext, imageId: string): Promise<ImageResolution> {
  if (isRemoteUrl(imageId)) {
    const downloaded = await fetchPublicImage(imageId);
    return { kind: 'loaded', image: { buffer: downloaded.buffer, contentType: downloaded.contentType } };
  }

  // `generate_image` returns both `id` and `url`, and the model passes either —
  // it passed `/api/upload/<id>` on dev and got "Invalid upload ID", which reads
  // as "that picture does not exist". Same normalization as attachments.
  const stored = await loadStoredImage(normalizeFileRef(imageId));
  if (stored) return { kind: 'loaded', image: stored };

  // The flat store is tried first and unconditionally: an image this very turn
  // generated is not in the transcript yet, so the conversation lookup below
  // cannot see it.
  //
  // Falling through to that lookup is what spans the SECOND store. Images
  // usually skip `chat_files` — but a composer with a skill or mission selected
  // routes every picked file there, images included, so the id the model was
  // handed never existed in the upload space at all.
  if (!ctx.sessionId) return { kind: 'missing' };
  const resolved = await resolveConversationFiles(ctx.db, ctx.sessionId, [imageId]);
  if (!resolved.ok) return { kind: 'missing' };
  const file = resolved.files[0];
  if (!file) return { kind: 'missing' };
  if (!file.content_type.startsWith('image/')) {
    return { kind: 'not_an_image', name: file.name, contentType: file.content_type };
  }
  const buffer = await file.read();
  return buffer ? { kind: 'loaded', image: { buffer, contentType: file.content_type } } : { kind: 'missing' };
}

export type VisionGenerate = (args: {
  prepared: PreparedVisionModel;
  prompt: string;
  imageBuffer: Buffer;
  mimeType: string;
}) => Promise<{ text: string; usage?: { inputTokens?: number; outputTokens?: number } }>;

const defaultVisionGenerate: VisionGenerate = async ({ prepared, prompt, imageBuffer, mimeType }) => {
  const result = await generateText({
    model: prepared.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image', image: imageBuffer, mediaType: mimeType },
        ],
      },
    ],
    maxOutputTokens: VISION_MAX_OUTPUT_TOKENS,
    maxRetries: VISION_MAX_RETRIES,
  });
  return { text: result.text, usage: result.usage };
};

export interface AnalyzeImageContext {
  db: DatabaseProvider;
  userId: string;
  sessionId?: string;
  /** Test seams; production callers leave these unset. */
  loadImage?: (imageId: string) => Promise<LoadedImage | null>;
  prepareModel?: () => Promise<PreparedVisionModel>;
  generate?: VisionGenerate;
}

/**
 * Check whether a string looks like an HTTP(S) URL.
 */
function isRemoteUrl(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'analyze_image',
  name: 'Image Analysis',
  brief: 'Extract important information from images',
  description: `Analyze an image by uploaded file ID or public HTTPS URL and extract the information most relevant to the user's request. Works with screenshots, emails, documents, charts, interfaces, product or plant photos, and general scenes without assuming a domain.
When the user attaches images or a ticket has public image attachments, you MUST call this tool for each image before responding. Pass the user's actual question when available so the analysis can focus on it. Report visible facts before inference, flag uncertainty, and never invent unreadable text. Pass a public HTTPS image URL directly as image_id; private-network URLs are rejected and must be re-uploaded first.`,
  category: 'core',
  is_global: true,
  builtin: true,
  surface: { proxy: 'read' },
  runtime_risk: 'r1',
  icon: 'Image',
  sort_order: 4,
};

export function createAnalyzeImageTool(ctx: AnalyzeImageContext) {
  return tool({
    description: meta.description,
    inputSchema: analyzeImageSchema,
    execute: async (input: AnalyzeImageInput) => {
      const { image_id, question } = input;
      const startTime = Date.now();

      let loaded: LoadedImage;

      try {
        const resolution = ctx.loadImage
          ? await ctx
              .loadImage(image_id)
              .then((image): ImageResolution => (image ? { kind: 'loaded', image } : { kind: 'missing' }))
          : await resolveImage(ctx, image_id);

        if (resolution.kind === 'not_an_image') {
          // Naming the file ends the search: without it the model reads any
          // failure here as "wrong id" and tries another one.
          return {
            error: `"${image_id}" is "${resolution.name}" (content type "${resolution.contentType}"), which is not an image — this tool reads image bytes only. Use read_attachment to read a document's text; if read_attachment already refused this file, follow what that error said instead of retrying here.`,
          };
        }
        if (resolution.kind === 'missing') {
          return {
            error: `Image not found: "${image_id}". Pass an image from THIS conversation — the id shown on its chip, or the id/url that generate_image returned — or a public HTTPS image URL.`,
          };
        }
        loaded = resolution.image;
      } catch (err) {
        const errorMsg = toErrorMessage(err);
        logger.error(`[Vision] ❌ Failed to load image ${image_id}: ${errorMsg}`);
        return {
          error: `Failed to load image: ${errorMsg}`,
          image_id,
          fallback: 'The image could not be loaded. Please check the URL or re-upload the image.',
        };
      }

      try {
        // Provider construction is local preflight. Reserve only after the
        // image and provider configuration are known to be usable.
        const prepared = await (ctx.prepareModel ?? createVisionModel)();
        const { modelId } = prepared;
        const prompt = buildVisionPrompt(question);
        const estimatedTokens = estimateVisionRequestTokens(question);
        const budget = await reserveUserTokenBudget({
          db: ctx.db,
          userId: ctx.userId,
          caller: 'vision',
          estimatedTokens,
          modelId,
          providerId: 'media',
          runId: ctx.sessionId,
          metadata: { session_id: ctx.sessionId, source: isRemoteUrl(image_id) ? 'remote_url' : 'upload' },
        });

        // Entering the generate seam is the provider boundary; a thrown error
        // after this point has an unknown billable outcome and stays reserved.
        budget.markProviderIoStarted();
        const result = await (ctx.generate ?? defaultVisionGenerate)({
          prepared,
          prompt,
          imageBuffer: loaded.buffer,
          mimeType: loaded.contentType,
        });

        const durationMs = Date.now() - startTime;

        logger.info(
          `[Vision] 🔍 Analyzed ${image_id} via ${modelId} in ${durationMs}ms (${result.usage?.inputTokens ?? '?'} in, ${result.usage?.outputTokens ?? '?'} out)`,
        );

        try {
          await settleAndRecordBudgetedUsage(ctx.db, budget, {
            profile_id: 'vision',
            caller: 'vision',
            session_id: ctx.sessionId,
            user_id: ctx.userId,
            model: modelId,
            input_tokens: result.usage?.inputTokens ?? 0,
            output_tokens: result.usage ? (result.usage.outputTokens ?? 0) : estimatedTokens,
            cached_tokens: 0,
            reasoning_tokens: 0,
            duration_ms: durationMs,
          });
        } catch (err) {
          logger.warn('[Vision] failed to settle budgeted usage', {
            imageId: image_id,
            budgetKey: budget.idempotencyKey,
            error: toErrorMessage(err),
          });
        }

        return {
          image_id,
          description: result.text,
          model: modelId,
          duration_ms: durationMs,
          usage: {
            input_tokens: result.usage?.inputTokens,
            output_tokens: result.usage?.outputTokens,
          },
        };
      } catch (err) {
        const errorMsg = toErrorMessage(err);
        logger.error(`[Vision] ❌ Failed to analyze ${image_id}: ${errorMsg}`);
        return {
          error: `Image analysis failed: ${errorMsg}`,
          image_id,
          fallback: 'Please describe what you see in the image so I can help you.',
        };
      }
    },
  });
}

export const analyzeImageTool = defineTool({ meta, kind: 'lazy' });
