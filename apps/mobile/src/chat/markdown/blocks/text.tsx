/**
 * The plain prose blocks: headings, paragraphs, rules, block quotes, and
 * bullet / numbered / task (- [ ] / - [x]) lists. All share the inline span
 * renderer for their text content.
 */
import { Text, View } from 'react-native';
import { makeStyles, radius, useTheme } from '../../../theme';
import { Icon } from '../../../ui';
import { Inline } from '../inline';

const HEADING = [
  { fontSize: 19, lineHeight: 27, marginTop: 18 },
  { fontSize: 17, lineHeight: 25, marginTop: 16 },
  { fontSize: 15.5, lineHeight: 23, marginTop: 14 },
  { fontSize: 14.5, lineHeight: 22, marginTop: 12 },
];

export function Heading({ level, text }: { level: number; text: string }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <Text style={[styles.h, HEADING[Math.min(level, 4) - 1]]}>
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
      <Text style={[styles.p, { color: c.fgSecondary, marginVertical: 0 }]}>
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
              <View style={[styles.checkbox, done && styles.checkboxOn]}>
                {done ? <Icon name="check" size={11} color={c.onAccent} sw={3} /> : null}
              </View>
              <Text style={[styles.p, { flex: 1, marginVertical: 0 }, done && styles.taskDone]}>
                <Inline text={task[2]} />
              </Text>
            </View>
          );
        }
        return (
          <View key={j} style={styles.li}>
            <Text style={styles.bullet}>•</Text>
            <Text style={[styles.p, { flex: 1, marginVertical: 0 }]}>
              <Inline text={it} />
            </Text>
          </View>
        );
      })}
    </View>
  );
}

export function OrderedList({ items }: { items: string[] }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <View style={styles.list}>
      {items.map((it, j) => (
        <View key={j} style={styles.li}>
          <View style={styles.num}>
            <Text style={styles.numText}>{j + 1}</Text>
          </View>
          <Text style={[styles.p, { flex: 1, marginVertical: 0 }]}>
            <Inline text={it} />
          </Text>
        </View>
      ))}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  p: { fontSize: 15, lineHeight: 25, color: c.fgSecondary, marginVertical: 6 },
  h: { fontWeight: '700', color: c.fg, marginBottom: 6 },
  hr: { height: 1, backgroundColor: c.hairline, marginVertical: 16 },

  list: { marginVertical: 5, gap: 5 },
  li: { flexDirection: 'row', gap: 9, alignItems: 'flex-start' },
  bullet: { color: c.accent, fontSize: 16, lineHeight: 25 },
  num: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: c.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 3,
  },
  numText: { fontSize: 11.5, fontWeight: '700', color: c.accentDeep },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: c.fgFaint,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 3,
  },
  checkboxOn: { backgroundColor: c.accent, borderColor: c.accent },
  taskDone: { color: c.fgFaint, textDecorationLine: 'line-through' },

  quote: {
    marginVertical: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderLeftWidth: 3,
    borderLeftColor: c.accentBorder,
    backgroundColor: c.accentTint,
    borderTopRightRadius: radius.sm,
    borderBottomRightRadius: radius.sm,
  },
}));
