/**
 * Content Sanitizer — clean and isolate external web content for safe LLM consumption.
 *
 * Defense layers:
 * 1. Length truncation — prevent context window abuse
 * 2. HTML/script stripping — remove executable content
 * 3. Prompt injection detection — reuse security.ts patterns
 * 4. XML envelope isolation — structural boundary between data and instructions
 *
 * The XML envelope approach tells the LLM explicitly that the content is
 * untrusted external data, not instructions to follow.
 */

import { checkPromptInjection } from '../../security.js';
import type { SanitizeResult } from './types.js';

/** Maximum characters per individual search result content */
const MAX_RESULT_CONTENT = 12_000;

/** Maximum characters for a snippet */
const MAX_SNIPPET_LENGTH = 500;

// ─── Main Sanitizer ──────────────────────────────────────

/**
 * Sanitize external web content for safe LLM consumption.
 *
 * Returns cleaned text wrapped in an XML envelope that clearly marks
 * the content as untrusted external data.
 */
export function sanitizeContent(content: string, sourceUrl: string): SanitizeResult {
  const flagReasons: string[] = [];
  let flagged = false;

  // 1. Length truncation
  let text = content.slice(0, MAX_RESULT_CONTENT);

  // 2. Strip any remaining HTML/script content
  text = stripDangerousContent(text);

  // 3. Prompt injection detection (reuse existing security module)
  const injectionCheck = checkPromptInjection(text);
  if (!injectionCheck.safe) {
    flagged = true;
    for (const detection of injectionCheck.detections) {
      flagReasons.push(`${detection.severity}: injection pattern detected`);
    }
    // For high-severity injections, redact the content entirely
    const hasHigh = injectionCheck.detections.some((d) => d.severity === 'high');
    if (hasHigh) {
      text = '[Content redacted: potential prompt injection detected]';
    }
  }

  // 4. Wrap in XML envelope for structural isolation
  const safeUrl = escapeXml(sourceUrl);
  const wrappedText = wrapInEnvelope(text, safeUrl, flagged);

  return {
    text: wrappedText,
    flagged,
    flagReasons,
  };
}

/**
 * Sanitize a snippet (shorter content, no envelope needed).
 */
export function sanitizeSnippet(snippet: string): string {
  let text = snippet.slice(0, MAX_SNIPPET_LENGTH);
  text = stripDangerousContent(text);
  return text;
}

// ─── Strip Dangerous Content ─────────────────────────────

/**
 * Remove potentially dangerous content patterns from text.
 * This handles content that might have slipped through HTML stripping.
 */
function stripDangerousContent(text: string): string {
  return (
    text
      // Remove any residual HTML tags
      .replace(/<[^>]+>/g, '')
      // Remove javascript: protocol
      .replace(/javascript\s*:/gi, '')
      // Remove data: URIs (could carry executable content)
      .replace(/data\s*:[^,\s]+;base64,[A-Za-z0-9+/=]+/gi, '[data-uri-removed]')
      // Remove zero-width characters (used for steganographic injection)
      .replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, '')
      // Normalize unicode to NFC (prevent decomposition attacks)
      .normalize('NFC')
  );
}

// ─── XML Envelope ────────────────────────────────────────

/**
 * Wrap content in an XML envelope that structurally separates it from
 * LLM instructions. The system prompt should instruct the LLM to treat
 * content within <external_source> tags as untrusted data only.
 */
function wrapInEnvelope(text: string, sourceUrl: string, flagged: boolean): string {
  const trustLevel = flagged ? 'flagged' : 'untrusted';
  return `<external_source url="${sourceUrl}" trust="${trustLevel}">\n${text}\n</external_source>`;
}

/**
 * Escape special XML characters in attribute values.
 */
export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
