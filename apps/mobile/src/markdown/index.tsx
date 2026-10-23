/**
 * Native Markdown — knowledge documents, comments and notification bodies, set in the app's text
 * styles (headings, lists, quotes, code with highlighting, pipe tables, image rows). Not full
 * CommonMark: the block grammar is ./parse (pure, ported from the v2 app), inline marks are
 * ./inline. Rich Output fences (charts, diagrams, html previews) are not run here: they render as
 * code, so nothing executable reaches the phone.
 *
 *   <Markdown source={string} preview? />
 *     - `preview`: a list excerpt — tables flatten to lines, images drop.
 *
 * Links: `#/…` app links and same-station links open in the app when it has the screen
 * (../lib/deep-links.ts), otherwise the in-app Safari view; other http(s) links open in Safari.
 */

import { useMemo } from 'react';
import { View } from 'react-native';
import { CalmContext, PreviewContext } from './context';
import { parseBlocks, type Block } from './parse';
import { CodeBlock } from './blocks/code';
import { ImageRow } from './blocks/images';
import { Table } from './blocks/table';
import { BulletList, Heading, OrderedList, Paragraph, Quote, Rule } from './blocks/text';

export type { TableData } from './parse';

function renderBlock(b: Block, i: number, preview: boolean) {
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
      return <OrderedList key={i} items={b.items} start={b.start} />;
    case 'quote':
      return <Quote key={i} text={b.text} />;
    case 'table':
      return preview ? (
        <Paragraph key={i} text={[b.data.head.join(' · '), ...b.data.rows.map((row) => row.join(' · '))].join('\n')} />
      ) : (
        <Table key={i} data={b.data} />
      );
    case 'images':
      return preview ? null : <ImageRow key={i} images={b.images} />;
    case 'code':
      return <CodeBlock key={i} lang={b.lang} code={b.text} />;
    default:
      return null;
  }
}

export function Markdown({ source, preview = false }: { source: string; preview?: boolean }) {
  const blocks = useMemo(() => parseBlocks(source), [source]);
  return (
    <CalmContext.Provider value={false}>
      <PreviewContext.Provider value={preview}>
        <View>{blocks.map((b, i) => renderBlock(b, i, preview))}</View>
      </PreviewContext.Provider>
    </CalmContext.Provider>
  );
}
