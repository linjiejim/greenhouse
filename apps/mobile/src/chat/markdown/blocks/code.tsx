/**
 * Fenced code block — an always-dark card (the `code*` tokens, same in light
 * and dark like Xcode / GitHub), a header with the language label and a copy
 * button (system HUD confirmation), light syntax colors (../highlight —
 * keywords, strings, numbers, comments; web parity), and horizontal scrolling
 * for long lines (`HScroll` — keeps the swipe-anywhere drawer working).
 */
import { useMemo } from 'react';
import { Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useT } from '../../../lib/i18n';
import { makeStyles, mono, radius, space, squircle, typo, useTheme, weight } from '../../../theme';
import { Icon, Touchable } from '../../../ui/core';
import { toast } from '../../../ui/toast';
import { highlight, type TokKind } from '../highlight';
import { HScroll } from './hscroll';

export function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const lines = useMemo(() => highlight(code, lang), [code, lang]);
  const tint: Record<Exclude<TokKind, 'plain'>, typeof c.codeText> = {
    comment: c.codeComment,
    string: c.codeString,
    number: c.codeNumber,
    keyword: c.codeKeyword,
  };
  const copy = async () => {
    await Clipboard.setStringAsync(code).catch(() => {});
    toast(t('common.copied'), 'copy');
  };
  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Text style={styles.lang}>{lang}</Text>
        <Touchable
          onPress={copy}
          hitSlop={10}
          style={styles.copy}
          accessibilityRole="button"
          accessibilityLabel={t('chat.actionCopy')}
        >
          <Icon name="copy" size={13} color={c.codeLabel} />
          <Text style={styles.copyText}>{t('chat.actionCopy')}</Text>
        </Touchable>
      </View>
      <HScroll>
        <View style={styles.body}>
          {lines.map((toks, i) => (
            <Text key={i} style={styles.line}>
              {toks.length
                ? toks.map((tk, j) =>
                    tk.kind === 'plain' ? (
                      tk.text
                    ) : (
                      <Text key={j} style={{ color: tint[tk.kind] }}>
                        {tk.text}
                      </Text>
                    ),
                  )
                : ' '}
            </Text>
          ))}
        </View>
      </HScroll>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  wrap: {
    marginVertical: space.sm + 2,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: c.codeBg,
    ...squircle,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space.sm - 1,
    paddingHorizontal: space.md,
    backgroundColor: c.codeHeader,
  },
  lang: { ...typo.caption1, fontFamily: mono, color: c.codeLabel },
  copy: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  copyText: { ...typo.caption1, fontWeight: weight.semibold, color: c.codeLabel },
  body: { paddingHorizontal: space.md + 2, paddingVertical: space.md },
  line: { ...typo.footnote, fontFamily: mono, lineHeight: 20, color: c.codeText },
}));
