/**
 * ```html-preview fenced block — a self-contained page the agent built (a
 * prototype, a small interactive tool). Like the web, it is NOT rendered
 * inline (a page assumes it owns a viewport, and every re-render of a long
 * conversation would re-run its scripts): the reply carries a compact card —
 * the page's own <title>, its size and a chevron — and the whole card opens
 * the full-screen viewer (`/peek/html`, an isolated WebView), whose ⤴ menu
 * copies the source or saves it as an .html file (2026-10: no buttons on the
 * card).
 */
import { useMemo } from 'react';
import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ChatCard } from '../../chat-card';
import { putHandoff } from '../../../lib/handoff';
import { formatBytes } from '../../../lib/format';
import { useT } from '../../../lib/i18n';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../../../theme';
import { Icon } from '../../../ui/core';
import { useRich } from '../context';
import { richSegment } from '../rich';
import { CodeBlock } from './code';

/** UTF-8 size of the page (CJK text is 3 bytes a character). */
function utf8Bytes(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

export function HtmlPreviewBlock({ raw }: { raw: string }) {
  const seg = useMemo(() => richSegment('html-preview', raw), [raw]);
  if (seg?.type !== 'html-preview') return <CodeBlock lang="html-preview" code={raw} />;
  return <HtmlPreview code={seg.code} title={seg.title} />;
}

function HtmlPreview({ code, title }: { code: string; title?: string }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  // The page may hand text back only where the member can write (a reply they own).
  const { reply } = useRich();
  const open = () =>
    router.push({
      pathname: '/peek/html',
      params: { k: putHandoff('html', { code, title, bridge: Boolean(reply) }) },
    });
  const name = title || t('chat.htmlPreview');
  const size = formatBytes(utf8Bytes(code));
  return (
    <ChatCard
      onPress={open}
      style={styles.card}
      accessibilityLabel={`${name}, ${t('chat.htmlPreview')} · ${size}`}
      accessibilityHint={t('chat.openPreview')}
    >
      <View style={styles.head}>
        <View style={styles.tile}>
          <Icon name="code" size={17} weight="semibold" color={c.accent} />
        </View>
        <View style={styles.texts}>
          <Text numberOfLines={2} style={styles.title}>
            {name}
          </Text>
          <Text style={styles.meta}>
            {t('chat.htmlPreview')} · {size}
          </Text>
        </View>
        <Icon name="chevR" size={13} weight="semibold" color={c.tertiaryLabel} />
      </View>
    </ChatCard>
  );
}

const useStyles = makeStyles((c) => ({
  card: { marginVertical: space.sm + 2, padding: space.md + 2 },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  tile: {
    width: 36,
    height: 36,
    borderRadius: radius.sm + 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentFill,
    ...squircle,
  },
  texts: { flex: 1, minWidth: 0 },
  title: { ...typo.subheadline, fontWeight: weight.semibold, color: c.label },
  meta: { ...typo.footnote, color: c.secondaryLabel, marginTop: 1 },
}));
