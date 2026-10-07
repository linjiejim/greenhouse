/**
 * Rich markdown renderer — agent replies, knowledge documents, task notes.
 * Set in iOS text styles (body 17 / 24-pt reading line, system label colors,
 * accent-tinted links). Re-parses on each streaming flush (memoised on
 * `source`); not full CommonMark, but covers what agent replies use.
 *
 * PUBLIC API (also used by the knowledge and projects areas — keep stable):
 *   <Markdown source={string} animated?={boolean} />
 *     - `source`   the markdown text.
 *     - `animated` streaming replies only: each block mounts with a soft
 *       fade-in, so the reply unfolds block by block (read only at a block's
 *       mount, so rendered blocks never re-animate), and a rich fence that
 *       hasn't closed yet shows a placeholder. Static renders omit it.
 *   <RichContext value={{ reply, followUp }}>  around a chat reply: lets a
 *       ```confirm send its pick (absent → inert buttons).
 *   <TableGrid data big? avail? />  the bare table grid (the /table viewer).
 *   type TableData                  a parsed pipe table.
 *
 * Links: entity deeplinks open native preview sheets, http(s) opens the
 * in-app Safari view, chat files download into the share sheet (see
 * ./inline); bare URLs are links. Tables pin an expand glyph that opens a
 * full-screen modal (./blocks/table); image-only paragraphs become thumbnails.
 *
 * The pieces:
 *   ./parse       — block grammar (pure data, no JSX)
 *   ./inline      — inline marks (**bold**, `code`, links, autolinks, <br>)
 *   ./registry    — custom ```<lang> blocks (the Rich Output fences: chart,
 *                   datatable, mermaid, html-preview, confirm, mission-artifacts)
 *   ./context     — what interactive blocks need from the reply (send a pick)
 *   ./blocks/*    — per-block renderers
 *
 * Add a block: register it in ./registry — nothing here changes.
 */
import { memo, useMemo } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { parseBlocks, type Block } from './parse';
import { fenceBlocks } from './registry';
import { CodeBlock } from './blocks/code';
import { BlockBoundary, PendingBlock } from './blocks/frame';
import { ImageRow } from './blocks/images';
import { Table } from './blocks/table';
import { BulletList, Heading, OrderedList, Paragraph, Quote, Rule } from './blocks/text';

export { TableGrid } from './blocks/table';
export { RichContext, type RichEnv } from './context';
export type { TableData } from './parse';

/** A registered fence — memoised on its body, so a finished block (a chart, a
 *  diagram's WebView) isn't re-rendered by every streaming tick after it. */
const Fence = memo(function Fence({ lang, raw }: { lang: string; raw: string }) {
  const Custom = fenceBlocks[lang];
  return (
    <BlockBoundary fallback={<CodeBlock lang={lang} code={raw} />}>
      <Custom raw={raw} />
    </BlockBoundary>
  );
});

function renderBlock(b: Block, i: number, live: boolean) {
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
      return <Table key={i} data={b.data} />;
    case 'images':
      return <ImageRow key={i} images={b.images} />;
    case 'code': {
      // Known fence langs (chart, …) render as their custom block; the rest
      // are plain code. This is the whole extension surface.
      if (!fenceBlocks[b.lang]) return <CodeBlock key={i} lang={b.lang} code={b.text} />;
      // still streaming in: no half-written JSON / HTML (turn-input fences render nothing anyway)
      if (b.open && live) return b.lang.endsWith('attachments') ? null : <PendingBlock key={i} lang={b.lang} />;
      return <Fence key={i} lang={b.lang} raw={b.text} />;
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
          {renderBlock(b, i, animated)}
        </Animated.View>
      ))}
    </View>
  );
}
