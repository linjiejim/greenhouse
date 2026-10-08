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
 * Links (iOS text-link styling: tinted, no underline):
 *  - entity deeplinks (`#/knowledge/doc/<id>-<slug>`, `#/projects/<id>`) open
 *    the native preview sheet (src/lib/entity-links.ts),
 *  - http(s) and uploaded images (`/api/upload/…`) → the in-app Safari view
 *    (src/lib/links.ts `openLink`); mailto / tel → the system (Mail, Phone),
 *  - chat files (`/api/chat-files/<id>/content`, e.g. an export_table result)
 *    → authenticated download + the system share sheet (Save to Files,
 *    AirDrop…; src/lib/share-file.ts), named after the link text; a short
 *    "正在准备文件…" HUD while it downloads, a system alert if it fails,
 *  - a Bots thread (`#/bots?c=<session>`) opens on home with Bots on; a
 *    session's full record (`#/chat?session=<id>` — a background task's
 *    report links its transcript) opens read-only on home (spec
 *    docs/specs/20261008-mobile-bots.md §2.4),
 *  - any other web-app route (`#/…`) or relative path has no surface here →
 *    a system alert saying it opens in the web app.
 */
import { type ReactNode, useCallback } from 'react';
import { Text } from 'react-native';
import { useRouter } from 'expo-router';
import { uploadUrl } from '../../api/upload';
import { entityRoute, parseEntityUrl } from '../../lib/entity-links';
import { useT } from '../../lib/i18n';
import { openLink } from '../../lib/links';
import { makeStyles, mono, type ThemeColors, typo, useTheme, weight } from '../../theme';
import { alertError } from '../../ui/dialogs';
import { saveFile } from '../file-card';
import { botsEnabledNow } from '../../bots/availability';
import { openChat, openThread } from '../../bots/nav';

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

const linkNode = (href: string, label: ReactNode, k: number, { s, open }: Ctx, name?: string) => (
  <Text key={k} style={s.link} onPress={() => open(href, name)} accessibilityRole="link">
    {label}
  </Text>
);

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
    node: (m, k, ctx, inner) => linkNode(m[2], inner(m[1]), k, ctx, m[1]),
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
    after: WORD_START,
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
    after: WORD_START,
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
  {
    // <https://…> — a CommonMark autolink
    re: /^<(https?:\/\/[^\s<>]+)>/,
    node: (m, k, ctx) => linkNode(m[1], m[1], k, ctx),
  },
  {
    // a bare URL (GFM autolink)
    re: BARE_URL,
    after: NOT_ALNUM,
    node: (m, k, ctx) => linkNode(m[0], m[0], k, ctx),
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
      // an uploaded / generated image (public, like the bubbles' thumbnails)
      if (/^\/api\/upload\//.test(href)) {
        void openLink(uploadUrl(href), hex.accent).catch(() => alertError(t('chat.linkFailed')));
        return;
      }
      if (/^\/api\/chat-files\//.test(href)) {
        saveFile(href, label ?? '');
        return;
      }
      // Web-app routes with a home surface here (a link may sit in a sheet: dismiss back to home).
      const thread = webRouteParam(href, 'bots', 'c');
      if (thread && botsEnabledNow()) {
        openThread(router, { c: thread }, 'dismissTo');
        return;
      }
      const record = webRouteParam(href, 'chat', 'session');
      if (record) {
        openChat(router, { id: record, ro: true }, 'dismissTo');
        return;
      }
      // Any other web-app route (`#/…`, incl. records with no mobile surface)
      // or relative link has no surface here.
      alertError(t('chat.webOnlyLink'));
    },
    [router, t, hex.accent],
  );
}

/** `name` from a web-app route's query (`#/<route>?…&name=value`), or null. */
function webRouteParam(href: string, route: string, name: string): string | null {
  const query = href.match(new RegExp(`^#/${route}\\?([^#]*)$`))?.[1];
  const value = query
    ?.split('&')
    .find((pair) => pair.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** An HTML line break (`<br>`, `<br/>`, `<br />`) — common in model-written table cells. */
const BR = /<br\s*\/?>/gi;

export function Inline({ text }: { text: string }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const open = useOpenLink();
  const t = useT();
  return <>{renderInline(text.replace(BR, '\n'), { s: styles, open, imageLabel: t('chat.image') })}</>;
}
