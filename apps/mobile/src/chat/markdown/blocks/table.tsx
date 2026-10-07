/**
 * Tables — one fixed width per column (rows stay aligned), per-column alignment,
 * hairline separators in the system separator color, horizontal scroll, and a
 * quiet expand glyph pinned to the header row's trailing corner that opens the
 * whole grid on the `/table` modal (handed over in memory via
 * src/lib/handoff.ts, kind `table`). Wide grids scroll horizontally in an
 * `HScroll` (keeps the swipe-anywhere drawer working); the header row is an
 * opaque fill, so the pinned glyph sits on a matching backdrop (a short fade on
 * its leading edge) that scrolled header text slides under, and the last
 * column's header keeps room for it at the end of the scroll.
 */
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { putHandoff } from '../../../lib/handoff';
import { useT } from '../../../lib/i18n';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../../../theme';
import { Icon, Touchable } from '../../../ui/core';
import { plainText } from '../../model';
import { Inline } from '../inline';
import type { Align, TableData } from '../parse';
import { HScroll } from './hscroll';

/** Cell padding, each side (keep in sync with `styles.cell`). */
const CELL_PAD = space.md;
/** Room the pinned expand glyph takes at the header's trailing end. */
const EXPAND_W = 34;
/** Its leading fade (scrolled header text dissolves into the backdrop). */
const FADE_W = 14;

/** Rough rendered width (pt) of a cell — CJK/emoji count wide, ASCII narrow.
 *  Only the first frame's guess: the real widths are measured (see TableGrid). */
const cellWidth = (s: string, charW: number, cjkW: number) => {
  let w = 0;
  for (const ch of plainText(s)) w += (ch.codePointAt(0) ?? 0) > 0x2e7f ? cjkW : charW;
  return w;
};

/** The bare grid — reused inline and on the full-screen page. `big` bumps the
 *  type size / column caps for the dedicated viewer. `avail` is the width the
 *  grid may occupy: when the natural grid is narrower, columns stretch to fill.
 *  `headEnd` reserves room at the end of the last header cell (for a control
 *  pinned over it); `onHeadPress` makes header cells tappable (sorting).
 *
 *  Column width = its widest cell's real one-line width, measured in an
 *  invisible layer laid out with the same text styles and inline marks — so
 *  short content stays on one line (no wrap from an under-estimate) — capped
 *  at `maxW`, where long content wraps; the grid scrolls sideways when wide. */
export function TableGrid({
  data,
  big,
  avail,
  headEnd = 0,
  onHeadPress,
  onHeadHeight,
}: {
  data: TableData;
  big?: boolean;
  avail?: number;
  headEnd?: number;
  onHeadPress?: (col: number) => void;
  onHeadHeight?: (h: number) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const { head, rows, align, plain } = data;
  const cols = Math.max(head.length, ...rows.map((r) => r.length));
  const text = big ? typo.body : typo.subheadline;
  const charW = big ? 9.4 : 8.4;
  const cjkW = big ? 17 : 15;
  const maxW = big ? 360 : 280;
  const minW = big ? 72 : 56;
  // A datatable's values are literal; a markdown table's cells carry inline marks.
  const content = (s: string) => (plain ? s : <Inline text={s} />);
  // Natural one-line text width per column, from the measuring layer below.
  const [measured, setMeasured] = useState<number[]>([]);
  const onMeasure = useCallback((j: number, w: number) => {
    setMeasured((m) => {
      if (m[j] !== undefined && Math.abs(m[j] - w) < 0.5) return m;
      const next = [...m];
      next[j] = w;
      return next;
    });
  }, []);
  const al = (j: number): Align => align?.[j] ?? 'left';
  const last = cols - 1;
  // The room at the header's end comes out of the last column: a left-aligned
  // column only pads its header; a right / centred one pads every cell, so
  // the header still lines up with the values under it.
  const padAll = headEnd > 0 && al(last) !== 'left';
  // One fixed width per column, shared by every row — otherwise each row is an
  // independent flex line and the same column drifts to a different width.
  const base = Array.from({ length: cols }, (_, j) => {
    let natural = measured[j];
    if (natural === undefined) {
      natural = 0;
      for (const cell of [head[j] ?? '', ...rows.map((r) => r[j] ?? '')])
        natural = Math.max(natural, cellWidth(cell, charW, cjkW));
      if (j === last && !padAll) natural = Math.max(natural, cellWidth(head[j] ?? '', charW, cjkW) + headEnd);
    }
    if (j === last && padAll) natural += headEnd;
    // +1: a cell a fraction narrower than its text wraps the last character.
    return Math.min(maxW + (j === last ? headEnd : 0), Math.max(minW, Math.ceil(natural) + 2 * CELL_PAD + 1));
  });
  // Stretch to fill when there's room (leftover pt land on the last column);
  // wider grids keep their natural widths and scroll horizontally.
  const natural = base.reduce((a, b) => a + b, 0);
  let widths = base;
  if (avail && natural > 0 && natural < avail) {
    const k = avail / natural;
    const scaled = base.map((w) => Math.floor(w * k));
    scaled[cols - 1] += Math.max(0, Math.round(avail - scaled.reduce((a, b) => a + b, 0)));
    widths = scaled;
  }
  const endPad = { paddingRight: CELL_PAD + headEnd };
  const headPad = (j: number) => (j === last && headEnd ? endPad : null);
  const bodyPad = (j: number) => (j === last && padAll ? endPad : null);

  return (
    <View>
      {/* measuring layer: each column shrink-wraps its widest cell (never shown, never read aloud) */}
      <View
        style={styles.measure}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {Array.from({ length: cols }, (_, j) => (
          <View key={j} style={styles.measureCol} onLayout={(e) => onMeasure(j, e.nativeEvent.layout.width)}>
            <Text style={[text, styles.cellHead, j === last && headEnd && !padAll ? { paddingRight: headEnd } : null]}>
              {content(head[j] ?? '')}
            </Text>
            {rows.map((r, ri) => (
              <Text key={ri} style={text}>
                {content(r[j] ?? '')}
              </Text>
            ))}
          </View>
        ))}
      </View>
      <HScroll yieldToDrawer={!big}>
        <View>
          <View style={[styles.tr, styles.trHead]} onLayout={(e) => onHeadHeight?.(e.nativeEvent.layout.height)}>
            {Array.from({ length: cols }, (_, j) => {
              const label = (
                <Text style={[text, styles.cellText, styles.cellHead, { textAlign: al(j) }]}>{content(head[j] ?? '')}</Text>
              );
              return onHeadPress ? (
                <Pressable
                  key={j}
                  onPress={() => onHeadPress(j)}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.cell, { width: widths[j] }, headPad(j), pressed && { opacity: 0.5 }]}
                >
                  {label}
                </Pressable>
              ) : (
                <View key={j} style={[styles.cell, { width: widths[j] }, headPad(j)]}>
                  {label}
                </View>
              );
            })}
          </View>
          {rows.map((r, ri) => (
            <View key={ri} style={[styles.tr, ri < rows.length - 1 && styles.trSep]}>
              {Array.from({ length: cols }, (_, ci) => (
                <View key={ci} style={[styles.cell, { width: widths[ci] }, bodyPad(ci)]}>
                  <Text style={[text, styles.cellText, { textAlign: al(ci) }]}>{content(r[ci] ?? '')}</Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      </HScroll>
    </View>
  );
}

/** Inline table: the grid in a rounded card, the expand glyph pinned to its header. */
export function Table({
  data,
  title,
  onHeadPress,
}: {
  data: TableData;
  /** Names the full-screen page (a ```datatable's title). */
  title?: string;
  onHeadPress?: (col: number) => void;
}) {
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  // Width the grid may use — measured so a narrow table stretches to fill it.
  const [avail, setAvail] = useState(0);
  const [headH, setHeadH] = useState(0);
  const open = () => {
    const k = putHandoff('table', data);
    router.push({ pathname: '/table', params: title ? { k, title } : { k } });
  };
  return (
    <View style={styles.wrap}>
      <View style={styles.card} onLayout={(e) => setAvail(Math.floor(e.nativeEvent.layout.width))}>
        <TableGrid
          data={data}
          avail={avail || undefined}
          headEnd={EXPAND_W + FADE_W - CELL_PAD}
          onHeadPress={onHeadPress}
          onHeadHeight={setHeadH}
        />
        {headH ? (
          <View style={[styles.pin, { height: headH }]} pointerEvents="box-none">
            <Svg width={FADE_W} height={headH} pointerEvents="none">
              <Defs>
                <LinearGradient id="fade" x1="0" y1="0" x2="1" y2="0">
                  <Stop offset="0" stopColor={hex.secondaryBackground} stopOpacity={0} />
                  <Stop offset="1" stopColor={hex.secondaryBackground} stopOpacity={1} />
                </LinearGradient>
              </Defs>
              <Rect x={0} y={0} width={FADE_W} height={headH} fill="url(#fade)" />
            </Svg>
            <Touchable
              onPress={open}
              hitSlop={{ top: 6, bottom: 6, left: 4, right: 6 }}
              style={styles.expand}
              accessibilityRole="button"
              accessibilityLabel={t('chat.fullscreen')}
            >
              <Icon name="expand" size={14} weight="medium" color={c.secondaryLabel} />
            </Touchable>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  wrap: { marginVertical: space.sm + 2 },
  card: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.separator,
    overflow: 'hidden',
    ...squircle,
  },
  tr: { flexDirection: 'row' },
  // opaque (not a translucent fill), so the pinned expand glyph can share it as a backdrop
  trHead: { backgroundColor: c.secondaryBackground },
  trSep: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.separator },
  // Cells are Views (not Texts) so separators render reliably on every density.
  cell: { paddingVertical: space.sm, paddingHorizontal: CELL_PAD },
  // Wide enough that no measured text wraps; out of layout, invisible, clipped by the card.
  measure: { position: 'absolute', top: 0, left: 0, width: 4000, opacity: 0, alignItems: 'flex-start' },
  measureCol: { alignItems: 'flex-start' },
  cellText: { color: c.label },
  cellHead: { fontWeight: weight.semibold },
  pin: { position: 'absolute', top: 0, right: 0, flexDirection: 'row' },
  expand: {
    width: EXPAND_W,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.secondaryBackground,
  },
}));
