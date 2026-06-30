/**
 * Content Extractor — fetch and extract clean text from web pages.
 *
 * Primary: Jina Reader API (r.jina.ai) — converts any URL to clean Markdown.
 * Fallback: Local fetch + HTML tag stripping.
 *
 * Jina Reader free tier: 1M tokens/month.
 * No API key required for basic usage.
 */

import type { ContentExtractor, ExtractedContent } from './types.js';

/** Maximum content size in characters (≈12K tokens) */
const MAX_CONTENT_LENGTH = 16_000;

/** Request timeout for content extraction */
const REQUEST_TIMEOUT_MS = 20_000;

// ─── Jina Reader Extractor ──────────────────────────────

export class JinaReaderExtractor implements ContentExtractor {
  private baseUrl = 'https://r.jina.ai';

  async extract(url: string): Promise<ExtractedContent> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.baseUrl}/${url}`, {
        method: 'GET',
        headers: {
          Accept: 'text/markdown',
          'X-Return-Format': 'markdown',
          // Jina Reader extracts via headless browser, handles JS-rendered pages
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Jina Reader ${response.status} for ${url}`);
      }

      const rawText = await response.text();
      const title = extractTitleFromMarkdown(rawText);
      const truncated = rawText.length > MAX_CONTENT_LENGTH;
      const content = truncated ? rawText.slice(0, MAX_CONTENT_LENGTH) + '\n\n[... content truncated]' : rawText;

      return {
        title,
        content,
        byteLength: rawText.length,
        truncated,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ─── Local Fallback Extractor ────────────────────────────

export class LocalFallbackExtractor implements ContentExtractor {
  async extract(url: string): Promise<ExtractedContent> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; GreenhouseBot/1.0)',
          Accept: 'text/html,application/xhtml+xml,text/plain',
        },
        signal: controller.signal,
        redirect: 'follow',
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} fetching ${url}`);
      }

      const html = await response.text();
      const title = extractTitleFromHTML(html);
      const rawText = stripHTMLTags(html);
      const truncated = rawText.length > MAX_CONTENT_LENGTH;
      const content = truncated ? rawText.slice(0, MAX_CONTENT_LENGTH) + '\n\n[... content truncated]' : rawText;

      return {
        title,
        content,
        byteLength: rawText.length,
        truncated,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ─── Combined Extractor (Jina primary, local fallback) ───

export class ContentExtractorChain implements ContentExtractor {
  private extractors: ContentExtractor[];

  constructor(extractors?: ContentExtractor[]) {
    this.extractors = extractors ?? [new JinaReaderExtractor(), new LocalFallbackExtractor()];
  }

  async extract(url: string): Promise<ExtractedContent> {
    let lastError: Error | null = null;

    for (const extractor of this.extractors) {
      try {
        return await extractor.extract(url);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Continue to next extractor
      }
    }

    throw lastError ?? new Error(`Failed to extract content from ${url}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────

/** Extract first H1 or first line as title from markdown. */
function extractTitleFromMarkdown(md: string): string {
  const match = md.match(/^#\s+(.+)$/m);
  if (match) return match[1].trim();
  const firstLine = md.split('\n').find((l) => l.trim().length > 0);
  return firstLine?.trim().slice(0, 120) || '(no title)';
}

/** Extract <title> from HTML. */
function extractTitleFromHTML(html: string): string {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? match[1].trim().slice(0, 120) : '(no title)';
}

/** Strip HTML tags and normalize whitespace. Exported for testing. */
export function stripHTMLTags(html: string): string {
  return (
    html
      // Remove script, style, noscript blocks entirely
      .replace(/<(script|style|noscript|svg|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
      // Remove HTML comments
      .replace(/<!--[\s\S]*?-->/g, '')
      // Convert <br>, <p>, <div>, <li> to newlines
      .replace(/<(br|p|div|li|h[1-6]|tr|blockquote)[^>]*\/?>/gi, '\n')
      // Remove remaining tags
      .replace(/<[^>]+>/g, '')
      // Decode common HTML entities
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      // Normalize whitespace
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}
