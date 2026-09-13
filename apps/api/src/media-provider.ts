/**
 * Shared media upstream config.
 *
 * One OpenAI-compatible endpoint serves both image understanding (`analyze_image`)
 * and image generation (`generate_image`): one key, one base URL. Set `MEDIA_*`
 * to point media at a dedicated provider (an aggregator, a vision-capable
 * gateway, …); unset, both fall back to the main `LLM_*` endpoint so a single
 * multimodal provider needs no extra configuration.
 */

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export interface MediaProviderConfig {
  apiKey: string;
  /** Base URL including the `/v1` suffix, with any trailing slash removed. */
  baseUrl: string;
}

/**
 * Read the media credentials, or throw a message naming the feature that needs them.
 * `feature` is what the operator sees when the key is missing (e.g. "image generation").
 */
export function getMediaProviderConfig(feature: string): MediaProviderConfig {
  const apiKey = process.env['MEDIA_API_KEY'] || process.env['LLM_API_KEY'];
  if (!apiKey) {
    throw new Error(`MEDIA_API_KEY not configured. Set it (or LLM_API_KEY) in .env to enable ${feature}.`);
  }
  const baseUrl = (process.env['MEDIA_BASE_URL'] || process.env['LLM_BASE_URL'] || DEFAULT_BASE_URL).replace(
    /\/+$/,
    '',
  );
  return { apiKey, baseUrl };
}
