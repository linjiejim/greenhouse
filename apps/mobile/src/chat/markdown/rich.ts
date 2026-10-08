/**
 * The Rich Output fences (```datatable, ```confirm, ```mermaid, …) validated
 * exactly like the web does it — through the vendored shared parser
 * (src/shared/rich-output.ts) — so a block web would reject degrades to a
 * plain code block here too, never to a half-rendered card.
 */
import { MODEL_FENCES, parseSegments, type ModelFence, type Segment } from '../../shared/rich-output';

/** One fence body as its validated segment; null = render it as code. */
export function richSegment(lang: string, raw: string): Segment | null {
  const [seg] = parseSegments('```' + lang + '\n' + raw + '\n```');
  return seg && seg.type !== 'markdown' && seg.type !== 'pending' ? seg : null;
}

/**
 * The Rich Output blocks this app draws — every model-authored one (the
 * registry in ./registry.tsx fails to compile without a renderer for each).
 * Sent as `rich_blocks` on every POST /api/chat, Chat and Bots alike, so the
 * model is only taught what renders here. Kept React-free: src/api imports it.
 */
export const MOBILE_RICH_BLOCKS: readonly ModelFence[] = MODEL_FENCES;
