/**
 * Inline span parser. `INLINE_TOKENS` is a registry tried in order at each
 * marker char — adding an inline mark (==highlight==, $math$, …) is one entry.
 * `boundary` tokens (underscore emphasis) only fire after a word boundary so
 * snake_case / foo_bar isn't italicised. Marks nest: bold / italic / strike /
 * link text is itself run through the parser (`**see `sorted()`**` renders
 * the code span inside the bold); inline code is the only leaf.
 *
 * Inline code sits on a tinted fill, padded with no-break spaces so the
 * padding never wraps away from the code onto its own line as an empty chip;
 * short space-free spans are glued with word joiners so `/v1` or `a.b()`
 * moves to the next line whole instead of splitting into two grey fragments.
 *
 * Bare URLs and `<https://…>` are links too (GFM autolinks; a URL ends at
 * whitespace, a CJK character or trailing punctuation), and an HTML `<br>` —
 * models put them in table cells — is a line break.
 *
 * Links are chips (./link-chip.tsx, rules in src/lib/link-chip.ts): a Greenhouse object shows
 * its type and title, a file its name and size, any other address its domain — never a raw URL.
 * Mail and phone links stay tinted text. Previews (approval cards) show the words only.
 */
import { type ReactNode, useCallback, useContext } from 'react';
import { CalmContext, PreviewContext } from './context';
import { Text } from 'react-native';
import { useT } from '../lib/i18n';
import { makeStyles, mono, type ThemeColors, typo, useTheme, weight } from '../theme';
import { alertError } from '../ui/dialogs';
import { useOpenHref } from '../shell/open-object';
import { chipFor, LinkChip } from './link-chip';

/** No-break space — keeps inline-code padding glued to the code when lines wrap. */
const NBSP = '\u00a0';
/** Word joiner (zero-width, no break) — keeps a short token like `/v1` from splitting at its `/`. */
const WJ = '\u2060';
/** Short, space-free code spans (identifiers, paths, flags) never wrap mid-token. */
const glue = (code: string) => (code.length <= 24 && !/\s/.test(code) ? Array.from(code).join(WJ) : code);

const useStyles = makeStyles((c: ThemeColors) => ({
  link: { color: c.link },
  medium: { fontWeight: weight.medium },
  plainCode: { backgroundColor: 'transparent' },
  bold: { fontWeight: weight.semibold, color: c.label },
  italic: { fontStyle: 'italic' as const },
  strike: { textDecorationLine: 'line-through' as const, color: c.secondaryLabel },
  // inline code: monospaced, slightly smaller, on the system tertiary fill
  inlineCode: {
    fontFamily: mono,
    fontSize: typo.subheadline.fontSize,
    color: c.label,
    backgroundColor: c.tertiaryFill,
  },
}));

type InlineStyles = ReturnType<typeof useStyles>;
/** `label` = the link's text (names a downloaded file). */
type OpenLink = (href: string, label?: string) => void;
interface Ctx {
  s: InlineStyles;
  open: OpenLink;
  imageLabel: string;
  preview: boolean;
  calm: boolean;
}

type InlineTok = {
  re: RegExp;
  /** Only fire after this kind of character (or at the start). */
  after?: RegExp;
  /** `inner(text)` renders nested marks inside this one. */
  node: (m: RegExpExecArray, key: number, ctx: Ctx, inner: (text: string) => ReactNode[]) => ReactNode;
};

/** A word boundary for `_` emphasis (snake_case / foo_bar stay literal). */
const WORD_START = /[\s([{<"'　-〿]/;
/** Not glued to a Latin word / number (`xhttp://` isn't a link; `见http://…` is). */
const NOT_ALNUM = /[^A-Za-z0-9]/;

/** Characters a bare URL never contains: whitespace, quotes, angle brackets, CJK text and punctuation. */
const URL_STOP = '\\s<>"\'`\\u2e80-\\u9fff\\u3000-\\u303f\\uff00-\\uffef';
/** …and may not end with (sentence punctuation after a link stays prose). */
const URL_TAIL = '.,;:!?)\\]}*_~';
const BARE_URL = new RegExp(`^https?:\\/\\/[^${URL_STOP}]*[^${URL_STOP}${URL_TAIL}]`);

const linkNode = (href: string, label: ReactNode, k: number, { s, open, preview }: Ctx, name?: string) => {
  if (preview) return <Text key={k}>{label}</Text>;
  const chip = chipFor(href, name);
  if (chip) return <LinkChip key={k} chip={chip} />;
  return (
    <Text key={k} style={s.link} onPress={() => open(href, name)} accessibilityRole="link">
      {label}
    </Text>
  );
};

const INLINE_TOKENS: InlineTok[] = [
  {
    re: /^!\[([^\]]*)\]\(\s*([^)\s]+)\s*\)/,
    node: (m, k, { s, open, imageLabel, preview }) =>
      preview ? null : (
        <Text key={k} style={s.link} onPress={() => open(m[2], m[1])} accessibilityRole="link">
          {`[${m[1] || imageLabel}]`}
        </Text>
      ),
  },
  {
    // CommonMark lets the destination sit between spaces: `[name]( /path )`
    re: /^\[([^\]]+)\]\(\s*([^)\s]+)\s*\)/,
    node: (m, k, ctx, inner) => linkNode(m[2], inner(m[1]), k, ctx, m[1]),
  },
  {
    re: /^\*\*(.+?)\*\*/,
    node: (m, k, { s, calm }, inner) => (
      <Text key={k} style={calm ? s.medium : s.bold}>
        {inner(m[1])}
      </Text>
    ),
  },
  {
    re: /^__(.+?)__/,
    after: WORD_START,
    node: (m, k, { s, calm }, inner) => (
      <Text key={k} style={calm ? s.medium : s.bold}>
        {inner(m[1])}
      </Text>
    ),
  },
  {
    re: /^~~(.+?)~~/,
    node: (m, k, { s }, inner) => (
      <Text key={k} style={s.strike}>
        {inner(m[1])}
      </Text>
    ),
  },
  {
    // `*x*` — not `2 * 3 * 4` (no space just inside the stars)
    re: /^\*([^\s*](?:[^*\n]*?[^\s*])?)\*/,
    node: (m, k, { s }, inner) => (
      <Text key={k} style={s.italic}>
        {inner(m[1])}
      </Text>
    ),
  },
  {
    re: /^_([^\s_](?:[^_\n]*?[^\s_])?)_/,
    after: WORD_START,
    node: (m, k, { s }, inner) => (
      <Text key={k} style={s.italic}>
        {inner(m[1])}
      </Text>
    ),
  },
  {
    re: /^`([^`]+?)`/,
    node: (m, k, { s, calm }) => (
      <Text key={k} style={[s.inlineCode, calm && s.plainCode]}>
        {calm ? m[1] : `${NBSP}${glue(m[1])}${NBSP}`}
      </Text>
    ),
  },
  {
    // <https://…> — a CommonMark autolink
    re: /^<(https?:\/\/[^\s<>]+)>/,
    node: (m, k, ctx) => linkNode(m[1], m[1], k, ctx, m[1]),
  },
  {
    // a bare URL (GFM autolink)
    re: BARE_URL,
    after: NOT_ALNUM,
    node: (m, k, ctx) => linkNode(m[0], m[0], k, ctx, m[0]),
  },
];

const MARKERS = new Set(['!', '[', '*', '_', '~', '`', '<', 'h']);

/** Tokenize `text` into spans (recursing into the nested marks). */
function renderInline(text: string, ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  const inner = (t: string) => renderInline(t, ctx);
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
      const prev = i === 0 ? '' : text[i - 1];
      const rest = text.slice(i);
      let hit = false;
      for (const tok of INLINE_TOKENS) {
        if (tok.after && prev && !tok.after.test(prev)) continue;
        const m = tok.re.exec(rest);
        if (m) {
          flush();
          out.push(tok.node(m, key++, ctx, inner));
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
  return out;
}

/** Route a tapped markdown link (see file header). Also opens ```cards items. */
export function useOpenLink(): OpenLink {
  const t = useT();
  const openHref = useOpenHref();
  return useCallback(
    (href: string) => {
      if (!openHref(href)) alertError(t('markdown.linkUnavailable'));
    },
    [openHref, t],
  );
}

/** An HTML line break (`<br>`, `<br/>`, `<br />`) — common in model-written table cells. */
const BR = /<br\s*\/?>/gi;

export function Inline({ text }: { text: string }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const open = useOpenLink();
  const t = useT();
  const preview = useContext(PreviewContext);
  const calm = useContext(CalmContext);
  return <>{renderInline(text.replace(BR, '\n'), { s: styles, open, imageLabel: t('markdown.image'), preview, calm })}</>;
}
