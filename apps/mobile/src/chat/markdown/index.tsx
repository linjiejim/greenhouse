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
 * Add a block: register it in ./registry — nothing here changes.
 */
import { useMemo } from 'react';
import { View } from 'react-native';
import { parseBlocks } from './parse';
import { fenceBlocks } from './registry';
import { CodeBlock } from './blocks/code';
import { Table } from './blocks/table';
import { BulletList, Heading, OrderedList, Paragraph, Quote, Rule } from './blocks/text';

export { TableGrid } from './blocks/table';

export function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseBlocks(source), [source]);
  return (
    <View>
      {blocks.map((b, i) => {
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
      })}
    </View>
  );
}
