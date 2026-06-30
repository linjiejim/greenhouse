/**
 * Shared JSON utilities — extraction, safe parsing.
 */

/**
 * Robustly extract a JSON object from LLM output.
 * Handles: thinking tags (closed & unclosed), markdown fences, leading text, nested braces.
 *
 * This is the canonical JSON extraction implementation used across the project.
 */
/**
 * Safely parse a JSON string, returning a fallback on failure.
 * Use for DB columns that store JSON text (e.g. references, meta, allowed_profiles).
 */
export function safeJsonParse(str: string | null | undefined, fallback: unknown = null): unknown {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/**
 * Robustly extract a JSON object from LLM output.
 * Handles: thinking tags (closed & unclosed), markdown fences, leading text, nested braces.
 *
 * This is the canonical JSON extraction implementation used across the project.
 */
export function extractJson(raw: string): string | null {
  // 1. Strip <think>...</think> blocks (closed)
  let text = raw.replace(/<think>[\s\S]*?<\/think>/g, '');

  // 2. Strip unclosed <think> tags (model cut off or didn't close)
  text = text.replace(/<think>[\s\S]*/g, '');

  // 3. Strip markdown code fences
  text = text.replace(/```json?\s*/g, '').replace(/```/g, '');

  // 4. Trim whitespace
  text = text.trim();

  // 5. Try to find a JSON structure — try arrays first if [ appears before {
  const braceStart = text.indexOf('{');
  const bracketStart = text.indexOf('[');

  // If array bracket appears first (or no object brace), try array
  if (bracketStart !== -1 && (braceStart === -1 || bracketStart < braceStart)) {
    const bracketEnd = text.lastIndexOf(']');
    if (bracketEnd > bracketStart) {
      const candidate = text.slice(bracketStart, bracketEnd + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        // Fall through to try object
      }
    }
  }

  if (braceStart === -1) return null;

  // Try from the first { to the last }
  const braceEnd = text.lastIndexOf('}');
  if (braceEnd === -1) return null;

  const candidate = text.slice(braceStart, braceEnd + 1);

  // 6. Validate it parses as JSON
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    // 7. Fallback: try to repair common issues
    let repaired = candidate.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');

    // Escape literal newlines/tabs inside JSON string values
    repaired = repaired.replace(/\r\n/g, '\\n').replace(/(["].*?)\n(.*?[":])/g, '$1\\n$2');

    try {
      JSON.parse(repaired);
      return repaired;
    } catch {
      // 8. Last resort: try each { position
      for (let i = braceStart + 1; i < text.length; i++) {
        if (text[i] === '{') {
          const sub = text.slice(i, braceEnd + 1);
          try {
            JSON.parse(sub);
            return sub;
          } catch {
            continue;
          }
        }
      }
      return null;
    }
  }
}
