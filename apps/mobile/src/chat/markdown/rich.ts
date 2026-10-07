/**
 * The Rich Output fences (```datatable, ```confirm, ```mermaid, …) validated
 * exactly like the web does it — through the vendored shared parser
 * (src/shared/rich-output.ts) — so a block web would reject degrades to a
 * plain code block here too, never to a half-rendered card.
 */
import { parseSegments, type Segment } from '../../shared/rich-output';

/** One fence body as its validated segment; null = render it as code. */
export function richSegment(lang: string, raw: string): Segment | null {
  const [seg] = parseSegments('```' + lang + '\n' + raw + '\n```');
  return seg && seg.type !== 'markdown' && seg.type !== 'datatable-pending' ? seg : null;
}
