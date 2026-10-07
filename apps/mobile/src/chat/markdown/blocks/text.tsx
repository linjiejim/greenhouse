/**
 * The plain prose blocks: headings, paragraphs, rules, block quotes, and
 * bullet / numbered / task (- [ ] / - [x]) lists — set in iOS text styles
 * (body 17 with a comfortable 24-pt reading line height, headings on
 * title3 / headline / subheadline) and system label colors. All share the
 * inline span renderer for their text content.
 */
import { StyleSheet, Text, View } from 'react-native';
import { makeStyles, space, typo, useTheme, weight } from '../../../theme';
import { Icon } from '../../../ui/core';
import { Inline } from '../inline';

/** Reading line height for long-form replies (body is 17 pt). */
export const PROSE_LINE = 24;

// h1 → title3, h2 → headline, h3 → callout, h4 → subheadline (all semibold+).
const HEADING = [
  { ...typo.title3, fontWeight: weight.bold, marginTop: space.xl },
  { ...typo.headline, marginTop: space.lg + 2 },
  { ...typo.callout, fontWeight: weight.semibold, marginTop: space.lg },
  { ...typo.subheadline, fontWeight: weight.semibold, marginTop: space.md },
] as const;

export function Heading({ level, text }: { level: number; text: string }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <Text style={[styles.h, HEADING[Math.min(Math.max(level, 1), 4) - 1]]} accessibilityRole="header">
      <Inline text={text} />
    </Text>
  );
}

export function Paragraph({ text }: { text: string }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <Text style={styles.p}>
      <Inline text={text} />
    </Text>
  );
}

export function Rule() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return <View style={styles.hr} />;
}

export function Quote({ text }: { text: string }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <View style={styles.quote}>
      <View style={styles.quoteBar} />
      <Text style={[styles.p, styles.quoteText]}>
        <Inline text={text} />
      </Text>
    </View>
  );
}

export function BulletList({ items }: { items: string[] }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <View style={styles.list}>
      {items.map((it, j) => {
        const task = it.match(/^\[( |x|X)\]\s+(.*)$/);
        if (task) {
          const done = task[1].toLowerCase() === 'x';
          return (
            <View key={j} style={styles.li}>
              <View style={styles.marker}>
                <Icon name={done ? 'checkCircleFill' : 'circle'} size={18} color={done ? c.accent : c.tertiaryLabel} />
              </View>
              <Text style={[styles.p, styles.liText, done && styles.taskDone]}>
                <Inline text={task[2]} />
              </Text>
            </View>
          );
        }
        return (
          <View key={j} style={styles.li}>
            <View style={styles.marker}>
              <View style={styles.bullet} />
            </View>
            <Text style={[styles.p, styles.liText]}>
              <Inline text={it} />
            </Text>
          </View>
        );
      })}
    </View>
  );
}

export function OrderedList({ items, start = 1 }: { items: string[]; start?: number }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <View style={styles.list}>
      {items.map((it, j) => (
        <View key={j} style={styles.li}>
          <Text style={[styles.p, styles.num]}>{start + j}.</Text>
          <Text style={[styles.p, styles.liText]}>
            <Inline text={it} />
          </Text>
        </View>
      ))}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  p: { ...typo.body, lineHeight: PROSE_LINE, color: c.label, marginVertical: space.xs + 2 },
  h: { color: c.label, marginBottom: space.xs },
  hr: { height: StyleSheet.hairlineWidth, backgroundColor: c.separator, marginVertical: space.lg },

  list: { marginVertical: space.xs, gap: space.xs },
  li: { flexDirection: 'row', alignItems: 'flex-start' },
  liText: { flex: 1, marginVertical: 0 },
  marker: { width: 22, height: PROSE_LINE, alignItems: 'flex-start', justifyContent: 'center' },
  bullet: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: c.secondaryLabel, marginLeft: 4 },
  num: {
    minWidth: 22,
    marginVertical: 0,
    paddingRight: space.xs,
    color: c.secondaryLabel,
    fontVariant: ['tabular-nums'],
  },
  taskDone: { color: c.secondaryLabel, textDecorationLine: 'line-through' },

  quote: { flexDirection: 'row', gap: space.md, marginVertical: space.sm },
  quoteBar: { width: 3, borderRadius: 1.5, backgroundColor: c.accent },
  quoteText: { flex: 1, color: c.secondaryLabel, marginVertical: 0 },
}));
