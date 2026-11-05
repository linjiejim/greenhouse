/**
 * Image understanding on the media endpoint — the one metered vision path.
 *
 * `analyze_image` (the chat tool) and plugins (through the kit's `analyzeImages`) both
 * come here, so a vision call is always admitted against the member's budget, metered as
 * the `vision` service and settled once, whoever asked. Provider configuration comes
 * from the environment / Runtime Config overlay:
 *   MEDIA_API_KEY / MEDIA_BASE_URL — shared media upstream (falls back to LLM_*), see ./media-provider.ts
 *   VISION_MODEL                   — multimodal model id (default: gpt-4o-mini)
 */
import { generateText } from 'ai';
import { getDb, type DatabaseProvider } from '@greenhouse/db';
import type { MeteringClient } from '@greenhouse/types/metering';
import { extractJson, safeJsonParse } from '@greenhouse/utils/json';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { detectImageContentType } from '../storage/uploads.js';
import { getMediaProviderConfig } from './media-provider.js';
import { reserveUserTokenBudget, settleAndRecordBudgetedUsage } from './usage-budget.js';

/** Conservative per-image allowance for provider-side image tokenization. */
export const VISION_IMAGE_TOKEN_ALLOWANCE = 32_768;
/** The largest image handed to the vision model. */
export const MAX_VISION_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VISION_IMAGES = 8;
export const MAX_VISION_PROMPT_CHARS = 16 * 1024;
const DEFAULT_MAX_OUTPUT_TOKENS = 1_200;
const MAX_OUTPUT_TOKENS = 4_000;

/**
 * Create the vision model client on the media endpoint.
 * Uses lazy dynamic import of @ai-sdk/openai.
 */
export async function createVisionModel() {
  const { apiKey, baseUrl } = getMediaProviderConfig('image analysis');
  const modelId = process.env.VISION_MODEL || 'gpt-4o-mini';
  const { createOpenAI } = await import('@ai-sdk/openai');
  const client = createOpenAI({ apiKey, baseURL: baseUrl });
  return { model: client.chat(modelId), modelId };
}

export type PreparedVisionModel = Awaited<ReturnType<typeof createVisionModel>>;

export interface VisionImagePart {
  buffer: Buffer;
  mimeType: string;
}

export type VisionGenerateMany = (args: {
  prepared: PreparedVisionModel;
  prompt: string;
  images: VisionImagePart[];
  maxOutputTokens: number;
  abortSignal?: AbortSignal;
}) => Promise<{ text: string; usage?: { inputTokens?: number; outputTokens?: number } }>;

const defaultGenerate: VisionGenerateMany = async ({ prepared, prompt, images, maxOutputTokens, abortSignal }) => {
  const result = await generateText({
    model: prepared.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          ...images.map((image) => ({ type: 'image' as const, image: image.buffer, mediaType: image.mimeType })),
        ],
      },
    ],
    maxOutputTokens,
    // Zero retries: each provider attempt would need its own reservation; a timed-out
    // billable first request must never hide behind one successful settlement.
    maxRetries: 0,
    ...(abortSignal ? { abortSignal } : {}),
  });
  return { text: result.text, usage: result.usage };
};

/**
 * Tokenizer-independent admission upper bound. UTF-8 bytes safely dominate the number of
 * byte-backed input tokens even for high-entropy/non-Latin text, while the image and output
 * allowances cover provider-side tokenization.
 */
export function estimateVisionTokens(prompt: string, imageCount: number, maxOutputTokens: number): number {
  const inputBytes = Buffer.byteLength(
    JSON.stringify([{ role: 'user', content: [{ type: 'text', text: prompt }] }]),
    'utf8',
  );
  return Math.max(1, inputBytes) + maxOutputTokens + VISION_IMAGE_TOKEN_ALLOWANCE * imageCount;
}

export interface RunVisionInput {
  db: DatabaseProvider;
  userId: string;
  sessionId?: string;
  /** Usage label (`vision` for the chat tool, the plugin id for plugins). */
  caller: string;
  prompt: string;
  images: VisionImagePart[];
  maxOutputTokens?: number;
  /** Override the admission estimate (the chat tool pins its historical formula). */
  estimatedTokens?: number;
  metadata?: Record<string, unknown>;
  client?: MeteringClient;
  abortSignal?: AbortSignal;
  /** Test seams; production callers leave these unset. */
  prepareModel?: () => Promise<PreparedVisionModel>;
  generate?: VisionGenerateMany;
}

export interface RunVisionResult {
  text: string;
  modelId: string;
  durationMs: number;
  usage: { inputTokens?: number; outputTokens?: number };
}

/** Reserve → call the provider once → settle. Budget refusals and provider errors propagate. */
export async function runVision(input: RunVisionInput): Promise<RunVisionResult> {
  const startTime = Date.now();
  const maxOutputTokens = input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  // Provider construction is local preflight. Reserve only after the images and provider
  // configuration are known to be usable.
  const prepared = await (input.prepareModel ?? createVisionModel)();
  const { modelId } = prepared;
  const estimatedTokens =
    input.estimatedTokens ?? estimateVisionTokens(input.prompt, input.images.length, maxOutputTokens);
  const budget = await reserveUserTokenBudget({
    db: input.db,
    userId: input.userId,
    caller: input.caller,
    estimatedTokens,
    modelId,
    providerId: 'media',
    runId: input.sessionId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    // Metered as the `vision` service at its token price (override, else services.yaml).
    service: 'vision',
    ...(input.client ? { client: input.client } : {}),
    metadata: { session_id: input.sessionId, images: input.images.length, ...input.metadata },
  });

  // Entering the generate seam is the provider boundary; a thrown error after this point
  // has an unknown billable outcome and stays reserved.
  budget.markProviderIoStarted();
  const result = await (input.generate ?? defaultGenerate)({
    prepared,
    prompt: input.prompt,
    images: input.images,
    maxOutputTokens,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  });
  const durationMs = Date.now() - startTime;

  try {
    await settleAndRecordBudgetedUsage(input.db, budget, {
      profile_id: 'vision',
      caller: input.caller,
      session_id: input.sessionId,
      user_id: input.userId,
      model: modelId,
      input_tokens: result.usage?.inputTokens ?? 0,
      output_tokens: result.usage ? (result.usage.outputTokens ?? 0) : estimatedTokens,
      cached_tokens: 0,
      reasoning_tokens: 0,
      duration_ms: durationMs,
    });
  } catch (err) {
    logger.warn('[Vision] failed to settle budgeted usage', {
      caller: input.caller,
      budgetKey: budget.idempotencyKey,
      error: toErrorMessage(err),
    });
  }
  return { text: result.text, modelId, durationMs, usage: result.usage ?? {} };
}

// ─── Kit surface ─────────────────────────────────────────

export interface AnalyzeImagesInput {
  /** The member whose budget the call consumes (an active internal account). */
  userId: string;
  /** 1–8 images, each ≤ 10 MB; the type is read from the bytes (jpeg, png, webp, gif). */
  images: Array<{ bytes: Buffer }>;
  prompt: string;
  /** Ask for a single JSON value; parsed into `json` when the reply contains one. */
  json?: boolean;
  /** Default 1200, at most 4000. */
  maxOutputTokens?: number;
  /** Usage label, e.g. the plugin id. */
  caller: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  client?: MeteringClient;
  abortSignal?: AbortSignal;
}

export interface AnalyzeImagesResult {
  text: string;
  /** The parsed JSON value when `json` was requested and the reply contained one. */
  json?: unknown;
  model: string;
  durationMs: number;
  usage: { inputTokens?: number; outputTokens?: number };
}

const JSON_INSTRUCTION =
  '\n\nReply with a single JSON value only: no Markdown fences, no commentary before or after it.';

/**
 * Metered image understanding for plugins. Throws on invalid input, a missing provider
 * configuration (naming MEDIA_API_KEY), a budget refusal, or a provider failure.
 */
export async function analyzeImages(
  input: AnalyzeImagesInput,
  seams: Pick<RunVisionInput, 'prepareModel' | 'generate'> & { db?: DatabaseProvider } = {},
): Promise<AnalyzeImagesResult> {
  if (!Array.isArray(input.images) || input.images.length < 1 || input.images.length > MAX_VISION_IMAGES)
    throw new Error(`analyzeImages takes 1–${MAX_VISION_IMAGES} images`);
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > MAX_VISION_PROMPT_CHARS)
    throw new Error(`analyzeImages needs a prompt of at most ${MAX_VISION_PROMPT_CHARS} characters`);
  const maxOutputTokens = input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > MAX_OUTPUT_TOKENS)
    throw new Error(`maxOutputTokens must be 1–${MAX_OUTPUT_TOKENS}`);
  const images = input.images.map(({ bytes }, i) => {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_VISION_IMAGE_BYTES)
      throw new Error(`Image ${i + 1} must be 1 byte–${MAX_VISION_IMAGE_BYTES} bytes`);
    const mimeType = detectImageContentType(bytes);
    if (!mimeType) throw new Error(`Image ${i + 1} is not a jpeg, png, webp or gif`);
    return { buffer: bytes, mimeType };
  });
  const prompt = input.json ? input.prompt + JSON_INSTRUCTION : input.prompt;
  const result = await runVision({
    db: seams.db ?? getDb(),
    userId: input.userId,
    caller: input.caller,
    prompt,
    images,
    maxOutputTokens,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.client ? { client: input.client } : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    ...(seams.prepareModel ? { prepareModel: seams.prepareModel } : {}),
    ...(seams.generate ? { generate: seams.generate } : {}),
  });
  const extracted = input.json ? extractJson(result.text) : null;
  const parsed = extracted ? safeJsonParse(extracted, undefined) : undefined;
  return {
    text: result.text,
    ...(parsed !== undefined && parsed !== null ? { json: parsed } : {}),
    model: result.modelId,
    durationMs: result.durationMs,
    usage: result.usage,
  };
}
