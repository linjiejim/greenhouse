/**
 * Tables — one fixed width per column (rows stay aligned), per-column alignment,
 * hairline separators in the system separator color, horizontal scroll, and a
 * “全屏” button (NativeButton, small tinted capsule) that opens the whole grid on the `/table` modal (handed over
 * in memory via src/lib/handoff.ts, kind `table`). Wide grids scroll
 * horizontally in an `HScroll` (keeps the swipe-anywhere drawer working).
 */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { putHandoff } from '../../../lib/handoff';
import { useT } from '../../../lib/i18n';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../../../theme';
import { NativeButton } from '../../../ui/button';
import { plainText } from '../../model';
import { Inline } from '../inline';
import type { Align, TableData } from '../parse';
import { HScroll } from './hscroll';

/** Rough rendered width (pt) of a cell — CJK/emoji count wide, ASCII narrow. The
 *  exact value doesn't matter for alignment (every row in a column shares one
 *  width); it only decides how wide each column gets. */
const cellWidth = (s: string, charW: number, cjkW: number) => {
  let w = 0;
  for (const ch of plainText(s)) w += (ch.codePointAt(0) ?? 0) > 0x2e7f ? cjkW : charW;
  return w;
};

/** The bare grid — reused inline and on the full-screen page. `big` bumps the
 *  type size / column caps for the dedicated viewer. `avail` is the width the
 *  grid may occupy: when the natural grid is narrower, columns stretch to fill. */
export function TableGrid({ data, big, avail }: { data: TableData; big?: boolean; avail?: number }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const { head, rows, align } = data;
  const cols = Math.max(head.length, ...rows.map((r) => r.length));
  const text = big ? typo.body : typo.subheadline;
  const charW = big ? 9.4 : 8.4;
  const cjkW = big ? 17 : 15;
  const maxW = big ? 340 : 260;
  const minW = big ? 72 : 64;
  // One fixed width per column, shared by every row — otherwise each row is an
  // independent flex line and the same column drifts to a different width.
  const base = Array.from({ length: cols }, (_, j) => {
    let m = 0;
    for (const cell of [head[j] ?? '', ...rows.map((r) => r[j] ?? '')]) m = Math.max(m, cellWidth(cell, charW, cjkW));
    return Math.round(Math.min(maxW, Math.max(minW, m + 28)));
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
  const al = (j: number): Align => align?.[j] ?? 'left';

  return (
    <HScroll yieldToDrawer={!big}>
      <View>
        <View style={[styles.tr, styles.trHead]}>
          {Array.from({ length: cols }, (_, j) => (
            <View key={j} style={[styles.cell, { width: widths[j] }]}>
              <Text style={[text, styles.cellText, styles.cellHead, { textAlign: al(j) }]}>
                <Inline text={head[j] ?? ''} />
              </Text>
            </View>
          ))}
        </View>
        {rows.map((r, ri) => (
          <View key={ri} style={[styles.tr, ri < rows.length - 1 && styles.trSep]}>
            {Array.from({ length: cols }, (_, ci) => (
              <View key={ci} style={[styles.cell, { width: widths[ci] }]}>
                <Text style={[text, styles.cellText, { textAlign: al(ci) }]}>
                  <Inline text={r[ci] ?? ''} />
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </HScroll>
  );
}

/** Inline table: the grid in a rounded card + a meta line with “全屏”. */
export function Table({ data }: { data: TableData }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  // Width the grid may use — measured so a narrow table stretches to fill it.
  const [avail, setAvail] = useState(0);
  const open = () => {
    const k = putHandoff('table', data);
    router.push({ pathname: '/table', params: { k } });
  };
  return (
    <View style={styles.wrap}>
      <View style={styles.card} onLayout={(e) => setAvail(Math.floor(e.nativeEvent.layout.width))}>
        <TableGrid data={data} avail={avail || undefined} />
      </View>
      <View style={styles.bar}>
        <Text style={styles.meta}>{t('chat.tableMeta', { cols: data.head.length, rows: data.rows.length })}</Text>
        <NativeButton label={t('chat.fullscreen')} icon="expand" size="small" onPress={open} />
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
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.sm },
  meta: { ...typo.footnote, color: c.secondaryLabel },
  tr: { flexDirection: 'row' },
  trHead: { backgroundColor: c.tertiaryFill },
  trSep: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.separator },
  // Cells are Views (not Texts) so separators render reliably on every density.
  cell: { paddingVertical: space.sm, paddingHorizontal: space.md },
  cellText: { color: c.label },
  cellHead: { fontWeight: weight.semibold },
}));
