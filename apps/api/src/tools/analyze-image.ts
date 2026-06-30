/**
 * analyze_image tool — understand uploaded images via an OpenAI-compatible
 * vision model. Called by the main LLM when the user attaches an image.
 *
 * Supports two input modes:
 *   1. Local file ID — resolves to UPLOADS_DIR (from /api/upload)
 *   2. Remote URL    — downloads the image first, then analyzes
 *
 * Does NOT require db — reads config from environment variables (no defaults;
 * the tool errors clearly when nothing is configured):
 *   IMAGE_API_KEY   — vision API key   (falls back to LLM_API_KEY)
 *   IMAGE_API_BASE_URL — vision API base URL (falls back to LLM_BASE_URL)
 *   VISION_MODEL    — model ID (falls back to LLM_MODEL)
 */

import { tool, generateText } from 'ai';
import { toErrorMessage } from '@greenhouse/utils/error';
import { defineTool, type ToolMeta } from './define.js';
import { logger } from '@greenhouse/utils/logger';
import { z } from 'zod';
import { extname } from 'node:path';
import { getDb } from '@greenhouse/db';
import { getUpload } from '../storage/uploads.js';

const VISION_PROMPT = `You are analyzing an image the user attached to their message.

Describe what you see in detail, focusing on:
1. **Subjects & objects**: What is in the image, their condition, and any notable details
2. **Text & labels**: Any visible text, numbers, codes, or labels
3. **General scene**: Overall environment, context, and anything that looks unusual or relevant

If the user asked a specific question, focus your analysis on answering that question.

User's question: {question}

Be specific, factual, and concise. Respond in English.`;

const analyzeImageSchema = z.object({
  image_id: z.string().describe('The image file ID (from upload) or a full URL (https://...) to analyze'),
  question: z.string().optional().describe('Specific question about the image from the user'),
});

type AnalyzeImageInput = z.infer<typeof analyzeImageSchema>;

/**
 * Create an OpenAI-compatible vision model client.
 * Reads IMAGE_API_* env vars, falling back to the main LLM_* config. There is
 * no hardcoded host — if nothing is configured the tool errors clearly.
 * Uses lazy dynamic import of @ai-sdk/openai.
 */
async function createVisionModel() {
  const apiKey = process.env.IMAGE_API_KEY || process.env.LLM_API_KEY;
  const baseURL = process.env.IMAGE_API_BASE_URL || process.env.LLM_BASE_URL;
  if (!apiKey || !baseURL) {
    throw new Error(
      'Image analysis is not configured. Set IMAGE_API_KEY + IMAGE_API_BASE_URL (or the main LLM_API_KEY + LLM_BASE_URL) in .env to enable it.',
    );
  }

  const modelId = process.env.VISION_MODEL || process.env.LLM_MODEL || 'gpt-4o-mini';
  const { createOpenAI } = await import('@ai-sdk/openai');
  const client = createOpenAI({
    apiKey,
    baseURL,
  });
  return { model: client.chat(modelId), modelId };
}

/**
 * Determine MIME type from file extension.
 */
function getMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  };
  return mimeMap[ext] || 'image/jpeg';
}

/**
 * Check whether a string looks like an HTTP(S) URL.
 */
function isRemoteUrl(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

/**
 * Download a remote image and return its buffer + inferred MIME type.
 * Throws on non-2xx responses or non-image content types.
 */
async function downloadRemoteImage(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`Failed to download image: HTTP ${res.status} ${res.statusText}`);
  }

  const contentType = res.headers.get('content-type') || '';
  // Derive MIME from Content-Type header, fall back to URL extension
  let mimeType = contentType.split(';')[0].trim();
  if (!mimeType.startsWith('image/')) {
    mimeType = getMimeType(url);
  }

  const arrayBuffer = await res.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), mimeType };
}

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'analyze_image',
  name: 'Image Analysis',
  brief: 'Analyze an image and describe what it shows',
  description: `Analyze images by file ID (from upload) or URL. Describes subjects, objects, visible text/labels, and the overall scene.
When the user attaches images, you MUST call this tool for each image before responding. Pass the image URL directly as image_id for remote images. Combine the analysis with knowledge base searches for comprehensive answers.`,
  category: 'public',
  is_global: true,
  icon: 'Image',
  sort_order: 4,
  surface: { proxy: 'read' },
};

export function createAnalyzeImageTool() {
  return tool({
    description: meta.description,
    inputSchema: analyzeImageSchema,
    execute: async (input: AnalyzeImageInput) => {
      const { image_id, question } = input;
      const startTime = Date.now();

      let imageBuffer: Buffer;
      let mimeType: string;

      try {
        if (isRemoteUrl(image_id)) {
          // ── Remote URL: download first ──
          const downloaded = await downloadRemoteImage(image_id);
          imageBuffer = downloaded.buffer;
          mimeType = downloaded.mimeType;
        } else {
          // ── Local file ID: resolve from storage (COS, with local-disk fallback) ──
          const stored = await getUpload(image_id);
          if (!stored) {
            return {
              error: `Image not found: ${image_id}. It may have been deleted or the ID is incorrect.`,
            };
          }
          imageBuffer = stored.buffer;
          mimeType = stored.contentType.startsWith('image/') ? stored.contentType : getMimeType(image_id);
        }
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
        const { model, modelId } = await createVisionModel();

        const prompt = VISION_PROMPT.replace('{question}', question || 'Describe the image in detail');

        const result = await generateText({
          model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image', image: imageBuffer, mediaType: mimeType },
              ],
            },
          ],
          maxOutputTokens: 1200,
        });

        const durationMs = Date.now() - startTime;

        logger.info(
          `[Vision] 🔍 Analyzed ${image_id} via ${modelId} in ${durationMs}ms (${result.usage?.inputTokens ?? '?'} in, ${result.usage?.outputTokens ?? '?'} out)`,
        );

        // Record vision API usage (fire-and-forget)
        if (result.usage) {
          getDb()
            .usage.record({
              profile_id: 'vision',
              caller: 'vision',
              model: modelId,
              input_tokens: result.usage.inputTokens ?? 0,
              output_tokens: result.usage.outputTokens ?? 0,
              cached_tokens: 0,
              reasoning_tokens: 0,
              duration_ms: durationMs,
            })
            .catch(() => {});
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

export const analyzeImageTool = defineTool({ meta, kind: 'static', create: () => createAnalyzeImageTool() });
