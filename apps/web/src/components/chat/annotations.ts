/**
 * Annotation parsing and utilities for user messages.
 * Handles the annotation prefix format produced by handleSend in chat.tsx.
 */

interface ParsedAnnotation {
  index: number;
  quote: string;
  note: string;
}

/**
 * Parse user message content that may contain an annotation prefix.
 * The annotation format (produced by handleSend in chat.tsx) is:
 *
 *   **[1]** > quote line 1
 *   > quote line 2
 *
 *   **Note 1:** note text
 *
 *   ---
 *
 *   actual user message
 */
export function parseAnnotatedContent(content: string): { annotations: ParsedAnnotation[]; message: string } | null {
  const sep = '\n\n---\n\n';
  const sepIdx = content.indexOf(sep);
  if (sepIdx === -1) return null;

  const prefix = content.slice(0, sepIdx);
  const message = content.slice(sepIdx + sep.length);

  // Verify this looks like annotations
  if (!prefix.startsWith('**[')) return null;

  // Split into individual annotation blocks: each starts with **[N]**
  const blocks = prefix.split(/\n\n(?=\*\*\[)/);
  const annotations: ParsedAnnotation[] = blocks.map((block) => {
    const indexMatch = block.match(/^\*\*\[(\d+)\]\*\*/);
    const index = indexMatch ? parseInt(indexMatch[1]) : 0;

    const lines = block.split('\n');
    const quoteLines: string[] = [];
    let note = '';

    for (const line of lines) {
      if (line.startsWith('**[') && line.includes('> ')) {
        // First line: **[N]** > text
        const afterPrefix = line.replace(/^\*\*\[\d+\]\*\*\s*/, '');
        if (afterPrefix.startsWith('> ')) {
          quoteLines.push(afterPrefix.slice(2));
        }
      } else if (line.startsWith('> ')) {
        quoteLines.push(line.slice(2));
      } else if (line.startsWith('**Note ')) {
        const noteMatch = line.match(/^\*\*Note \d+:\*\*\s*(.*)/);
        if (noteMatch) note = noteMatch[1];
      }
    }

    return { index, quote: quoteLines.join('\n'), note };
  });

  if (annotations.length === 0) return null;

  return { annotations, message };
}

/** Deduplicate array by a key function, keeping first occurrence */
export function dedupe<T>(arr: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  return arr.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
