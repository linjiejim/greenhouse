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
 * Links (iOS text-link styling: tinted, no underline):
 *  - entity deeplinks (`#/knowledge/doc/<id>-<slug>`, `#/projects/<id>`) open
 *    the native preview sheet (src/lib/entity-links.ts),
 *  - http(s) → the in-app Safari view (src/lib/links.ts `openLink`); mailto /
 *    tel → the system (Mail, Phone),
 *  - chat files (`/api/chat-files/<id>/content`, e.g. an export_table result)
 *    → authenticated download + the system share sheet (Save to Files,
 *    AirDrop…; src/lib/share-file.ts), named after the link text; a short
 *    "正在准备文件…" HUD while it downloads, a system alert if it fails,
 *  - any other web-app route (`#/…`) or relative path has no surface here →
 *    a system alert saying it opens in the web app.
 */
import { type ReactNode, useCallback } from 'react';
import { Text } from 'react-native';
import { useRouter } from 'expo-router';
import { entityRoute, parseEntityUrl } from '../../lib/entity-links';
import { useT } from '../../lib/i18n';
import { openLink } from '../../lib/links';
import { downloadAndShare } from '../../lib/share-file';
import { makeStyles, mono, type ThemeColors, typo, useTheme, weight } from '../../theme';
import { alertError } from '../../ui/dialogs';
import { toast } from '../../ui/toast';

/** One chat-file download at a time (a double tap must not open two share sheets). */
let downloading = false;

/** No-break space — keeps inline-code padding glued to the code when lines wrap. */
const NBSP = '\u00a0';
/** Word joiner (zero-width, no break) — keeps a short token like `/v1` from splitting at its `/`. */
const WJ = '\u2060';
/** Short, space-free code spans (identifiers, paths, flags) never wrap mid-token. */
const glue = (code: string) => (code.length <= 24 && !/\s/.test(code) ? Array.from(code).join(WJ) : code);

const useStyles = makeStyles((c: ThemeColors) => ({
  link: { color: c.link },
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
}

type InlineTok = {
  re: RegExp;
  boundary?: boolean;
  /** `inner(text)` renders nested marks inside this one. */
  node: (m: RegExpExecArray, key: number, ctx: Ctx, inner: (text: string) => ReactNode[]) => ReactNode;
};

const INLINE_TOKENS: InlineTok[] = [
  {
    re: /^!\[([^\]]*)\]\(([^)\s]+)\)/,
    node: (m, k, { s, open, imageLabel }) => (
      <Text key={k} style={s.link} onPress={() => open(m[2], m[1])} accessibilityRole="link">
        {`[${m[1] || imageLabel}]`}
      </Text>
    ),
  },
  {
    re: /^\[([^\]]+)\]\(([^)\s]+)\)/,
    node: (m, k, { s, open }, inner) => (
      <Text key={k} style={s.link} onPress={() => open(m[2], m[1])} accessibilityRole="link">
        {inner(m[1])}
      </Text>
    ),
  },
  {
    re: /^\*\*(.+?)\*\*/,
    node: (m, k, { s }, inner) => (
      <Text key={k} style={s.bold}>
        {inner(m[1])}
      </Text>
    ),
  },
  {
    re: /^__(.+?)__/,
    boundary: true,
    node: (m, k, { s }, inner) => (
      <Text key={k} style={s.bold}>
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
    boundary: true,
    node: (m, k, { s }, inner) => (
      <Text key={k} style={s.italic}>
        {inner(m[1])}
      </Text>
    ),
  },
  {
    re: /^`([^`]+?)`/,
    node: (m, k, { s }) => (
      <Text key={k} style={s.inlineCode}>
        {`${NBSP}${glue(m[1])}${NBSP}`}
      </Text>
    ),
  },
];

const MARKERS = new Set(['!', '[', '*', '_', '~', '`']);

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
      const prevBoundary = i === 0 || /[\s([{<"'　-〿]/.test(text[i - 1]);
      const rest = text.slice(i);
      let hit = false;
      for (const tok of INLINE_TOKENS) {
        if (tok.boundary && !prevBoundary) continue;
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

/** Route a tapped markdown link (see file header). */
function useOpenLink(): OpenLink {
  const router = useRouter();
  const t = useT();
  const { hex } = useTheme();
  return useCallback(
    (href: string, label?: string) => {
      const ref = parseEntityUrl(href);
      const route = ref ? entityRoute(ref) : null;
      if (route) {
        router.push(route);
        return;
      }
      if (/^(https?:|mailto:|tel:)/i.test(href)) {
        void openLink(href, hex.accent).catch(() => alertError(t('chat.linkFailed')));
        return;
      }
      if (/^\/api\/chat-files\//.test(href)) {
        if (downloading) return;
        downloading = true;
        toast(t('chat.preparingFile'), 'download');
        void downloadAndShare(href, label?.trim() || 'download').then((ok) => {
          downloading = false;
          if (!ok) alertError(t('chat.downloadFailed'));
        });
        return;
      }
      // Any other web-app route (`#/…`, incl. records with no mobile surface)
      // or relative link has no surface here.
      alertError(t('chat.webOnlyLink'));
    },
    [router, t, hex.accent],
  );
}

export function Inline({ text }: { text: string }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const open = useOpenLink();
  const t = useT();
  return <>{renderInline(text, { s: styles, open, imageLabel: t('chat.image') })}</>;
}
