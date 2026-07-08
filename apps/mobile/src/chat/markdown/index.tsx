/**
 * Rich markdown renderer for AI replies — Sage styled. Re-parses on each
 * streaming flush (memoised on `source`); not full CommonMark, but covers what
 * agent replies use. The pieces:
 *
 *   ./parse       — block grammar (pure data, no JSX)
 *   ./inline      — inline marks (**bold**, `code`, links, …)
 *   ./registry    — custom ```<lang> blocks (chart today, mermaid/etc. later)
 *   ./blocks/*    — per-block renderers (code, chart, table, text/lists/quote)
 *
 * `animated` (streaming replies only): each block mounts with a soft fade-in,
 * so the reply unfolds block by block instead of popping in. The prop is only
 * read at a block's mount, so already-rendered blocks never re-animate and
 * history renders (animated=false) stay static.
 *
 * Add a block: register it in ./registry — nothing here changes.
 */
import { useMemo } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { parseBlocks, type Block } from './parse';
import { fenceBlocks } from './registry';
import { CodeBlock } from './blocks/code';
import { Table } from './blocks/table';
import { BulletList, Heading, OrderedList, Paragraph, Quote, Rule } from './blocks/text';

export { TableGrid } from './blocks/table';

function renderBlock(b: Block, i: number) {
  switch (b.kind) {
    case 'heading':
      return <Heading key={i} level={b.level} text={b.text} />;
    case 'p':
      return <Paragraph key={i} text={b.text} />;
    case 'hr':
      return <Rule key={i} />;
    case 'ul':
      return <BulletList key={i} items={b.items} />;
    case 'ol':
      return <OrderedList key={i} items={b.items} />;
    case 'quote':
      return <Quote key={i} text={b.text} />;
    case 'table':
      return <Table key={i} data={b.data} />;
    case 'code': {
      // Known fence langs (chart, …) render as their custom block; the rest
      // are plain code. This is the whole extension surface.
      const Custom = fenceBlocks[b.lang];
      return Custom ? <Custom key={i} raw={b.text} /> : <CodeBlock key={i} lang={b.lang} code={b.text} />;
    }
    default:
      return null;
  }
}

export function Markdown({ source, animated = false }: { source: string; animated?: boolean }) {
  const blocks = useMemo(() => parseBlocks(source), [source]);
  return (
    <View>
      {blocks.map((b, i) => (
        <Animated.View key={i} entering={animated ? FadeIn.duration(260) : undefined}>
          {renderBlock(b, i)}
        </Animated.View>
      ))}
    </View>
  );
}
