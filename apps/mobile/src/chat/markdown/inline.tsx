/**
 * Inline span parser. `INLINE_TOKENS` is a registry tried in order at each
 * marker char — adding an inline mark (==highlight==, $math$, …) is one entry.
 * `boundary` tokens (underscore emphasis) only fire after a word boundary so
 * snake_case / foo_bar isn't italicised.
 */
import { type ReactNode } from 'react';
import { Linking, Text } from 'react-native';
import { font, makeStyles, mono, type ThemeColors, useTheme } from '../../theme';

export const openURL = (url: string) => Linking.openURL(url).catch(() => {});

const useStyles = makeStyles((c: ThemeColors) => ({
  link: { color: c.accent, textDecorationLine: 'underline' as const },
  bold: { fontWeight: '700' as const, color: c.fg },
  italic: { fontStyle: 'italic' as const },
  strike: { textDecorationLine: 'line-through' as const, color: c.fgMuted },
  inlineCode: { fontFamily: mono, fontSize: font.small, color: c.accentDeep, backgroundColor: c.surfaceMuted },
}));

type InlineStyles = ReturnType<typeof useStyles>;

type InlineTok = {
  re: RegExp;
  boundary?: boolean;
  node: (m: RegExpExecArray, key: number, styles: InlineStyles) => ReactNode;
};

const INLINE_TOKENS: InlineTok[] = [
  {
    re: /^!\[([^\]]*)\]\(([^)\s]+)\)/,
    node: (m, k, s) => (
      <Text key={k} style={s.link} onPress={() => openURL(m[2])}>{`🖼 ${m[1] || '图片'}`}</Text>
    ),
  },
  {
    re: /^\[([^\]]+)\]\(([^)\s]+)\)/,
    node: (m, k, s) => (
      <Text key={k} style={s.link} onPress={() => openURL(m[2])}>
        {m[1]}
      </Text>
    ),
  },
  { re: /^\*\*([^*]+?)\*\*/, node: (m, k, s) => <Text key={k} style={s.bold}>{m[1]}</Text> },
  { re: /^__([^_]+?)__/, boundary: true, node: (m, k, s) => <Text key={k} style={s.bold}>{m[1]}</Text> },
  { re: /^~~([^~]+?)~~/, node: (m, k, s) => <Text key={k} style={s.strike}>{m[1]}</Text> },
  { re: /^\*([^*\n]+?)\*/, node: (m, k, s) => <Text key={k} style={s.italic}>{m[1]}</Text> },
  { re: /^_([^_\n]+?)_/, boundary: true, node: (m, k, s) => <Text key={k} style={s.italic}>{m[1]}</Text> },
  { re: /^`([^`]+?)`/, node: (m, k, s) => <Text key={k} style={s.inlineCode}>{` ${m[1]} `}</Text> },
];

const MARKERS = new Set(['!', '[', '*', '_', '~', '`']);

export function Inline({ text }: { text: string }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const out: ReactNode[] = [];
  let buf = '';
  let i = 0;
  let key = 0;
  const flush = () => {
    if (buf) {
      out.push(<Text key={`t${key++}`}>{buf}</Text>);
      buf = '';
    }
  };
  while (i < text.length) {
    const ch = text[i];
    if (MARKERS.has(ch)) {
      const prevBoundary = i === 0 || /[\s([{<"'　-〿]/.test(text[i - 1]);
      const rest = text.slice(i);
      let hit = false;
      for (const tok of INLINE_TOKENS) {
        if (tok.boundary && !prevBoundary) continue;
        const m = tok.re.exec(rest);
        if (m) {
          flush();
          out.push(tok.node(m, key++, styles));
          i += m[0].length;
          hit = true;
          break;
        }
      }
      if (hit) continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return <>{out}</>;
}
