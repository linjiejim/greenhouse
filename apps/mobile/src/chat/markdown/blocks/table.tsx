/**
 * Tables — one fixed width per column (rows stay aligned), per-column alignment,
 * reliable hairline dividers, horizontal scroll, and a “全屏” button that opens
 * the full grid on a dedicated page. Horizontal scrollers use gesture-handler's
 * ScrollView so a sideways swipe is claimed even inside the vertical chat scroll.
 */
import { useState } from 'react';
import { Text, View } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { useRouter } from 'expo-router';
import { font, makeStyles, radius, useTheme } from '../../../theme';
import { Icon, Touchable } from '../../../ui';
import { Inline } from '../inline';
import { putTable, type Align, type TableData } from '../../table-store';

/** Strip inline markdown that doesn't affect rendered width. */
const plainText = (s: string) =>
  s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

/** Rough rendered width (px) of a cell — CJK/emoji count wide, ASCII narrow. The
 *  exact value doesn't matter for alignment (every row in a column shares one
 *  width); it only decides how wide each column gets. */
const cellWidth = (s: string, charW: number, cjkW: number) => {
  let w = 0;
  for (const ch of plainText(s)) w += (ch.codePointAt(0) ?? 0) > 0x2e7f ? cjkW : charW;
  return w;
};

/** The bare grid — reused inline and on the fullscreen page. `big` bumps the
 *  type size / column caps for the dedicated viewer. `avail` is the width the
 *  grid may occupy: when the natural grid is narrower, columns stretch to fill. */
export function TableGrid({ data, big, avail }: { data: TableData; big?: boolean; avail?: number }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const { head, rows, align } = data;
  const cols = Math.max(head.length, ...rows.map((r) => r.length));
  const fs = big ? 15 : 13.5;
  const charW = big ? 8.6 : 7.4;
  const cjkW = big ? 15 : 13.5;
  const maxW = big ? 340 : 260;
  const minW = big ? 72 : 64;
  // One fixed width per column, shared by every row. Without this each row is an
  // independent flex line whose cells size to their own content, so the same
  // column ends up a different width per row and the columns drift out of line.
  const base = Array.from({ length: cols }, (_, j) => {
    let m = 0;
    for (const c of [head[j] ?? '', ...rows.map((r) => r[j] ?? '')]) m = Math.max(m, cellWidth(c, charW, cjkW));
    return Math.round(Math.min(maxW, Math.max(minW, m + 30)));
  });
  // Stretch to fill when there's room: if the natural grid is narrower than the
  // space available, scale every column proportionally so the table spans the
  // full width (leftover px land on the last column). Wider grids keep their
  // natural widths and scroll horizontally.
  const natural = base.reduce((a, b) => a + b, 0);
  let widths = base;
  if (avail && natural > 0 && natural < avail) {
    const target = avail - 1; // spare 1px for the grid's right hairline
    const k = target / natural;
    const scaled = base.map((w) => Math.floor(w * k));
    const used = scaled.reduce((a, b) => a + b, 0);
    scaled[cols - 1] += Math.max(0, Math.round(target - used));
    widths = scaled;
  }
  const al = (j: number): Align => align?.[j] ?? 'left';

  return (
    <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator style={styles.grid} contentContainerStyle={styles.gridContent}>
      <View>
        <View style={[styles.tr, styles.trHead]}>
          {Array.from({ length: cols }, (_, j) => (
            <View key={j} style={[styles.cellBox, { width: widths[j] }, j > 0 && styles.cellDivider]}>
              <Text style={[styles.cellText, { fontSize: fs, textAlign: al(j) }, styles.cellStrong]}>
                <Inline text={head[j] ?? ''} />
              </Text>
            </View>
          ))}
        </View>
        {rows.map((r, ri) => (
          <View key={ri} style={[styles.tr, ri < rows.length - 1 && styles.trBorder]}>
            {Array.from({ length: cols }, (_, ci) => (
              <View key={ci} style={[styles.cellBox, { width: widths[ci] }, ci > 0 && styles.cellDivider]}>
                <Text style={[styles.cellText, { fontSize: fs, textAlign: al(ci) }, ci === 0 && styles.cellStrong]}>
                  <Inline text={r[ci] ?? ''} />
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

/** Inline table: a toolbar (column/row count + “全屏”) over the bleed-to-edge grid. */
export function Table({ data }: { data: TableData }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const router = useRouter();
  // Width the grid may bleed into (content edge → screen edge). Measured so a
  // narrow table can stretch to fill it rather than sitting in a cramped column.
  const [avail, setAvail] = useState(0);
  const open = () => {
    const k = putTable(data);
    router.push({ pathname: '/table', params: { k } });
  };
  return (
    <View style={styles.tableWrap}>
      <View style={styles.tableBar}>
        <Text style={styles.tableHint}>{data.head.length} 列 · {data.rows.length} 行 · 左右滑动</Text>
        <Touchable haptic="light" onPress={open} style={styles.expandBtn} hitSlop={6}>
          <Icon name="expand" size={14} color={c.accentDeep} />
          <Text style={styles.expandText}>全屏</Text>
        </Touchable>
      </View>
      <View style={styles.tableBleed} onLayout={(e) => setAvail(e.nativeEvent.layout.width)}>
        <TableGrid data={data} avail={avail || undefined} />
      </View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  tableWrap: { marginVertical: 12 },
  tableBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 },
  tableHint: { fontSize: font.caption, color: c.fgFaint },
  expandBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: radius.full,
    backgroundColor: c.accentTint,
    borderWidth: 1,
    borderColor: c.accentBorder,
  },
  expandText: { fontSize: font.caption, fontWeight: '600', color: c.accentDeep },
  tableBleed: { marginRight: -16 },
  grid: { borderTopWidth: 1, borderBottomWidth: 1, borderColor: c.hairline },
  gridContent: { borderRightWidth: 1, borderRightColor: c.hairline },
  tr: { flexDirection: 'row' },
  trHead: { backgroundColor: c.surfaceMuted, borderBottomWidth: 1, borderBottomColor: c.hairline },
  trBorder: { borderBottomWidth: 1, borderBottomColor: c.hairline },
  // Cells are Views (not Texts) so the hairline dividers render reliably on
  // Android — borders on <Text> are dropped on some densities.
  // Compact vertical rhythm so chat tables stay short; width comes from stretch.
  cellBox: { paddingVertical: 8, paddingHorizontal: 15 },
  cellDivider: { borderLeftWidth: 1, borderLeftColor: c.hairline },
  cellText: { lineHeight: 20, color: c.fgSecondary },
  cellStrong: { fontWeight: '600', color: c.fg },
}));
