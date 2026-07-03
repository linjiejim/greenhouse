import { useState } from 'react';
import { Text, View } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import * as Clipboard from 'expo-clipboard';
import { useT } from '../../../lib/i18n';
import { makeStyles, mono, radius, useTheme } from '../../../theme';
import { Icon, Touchable } from '../../../ui';

/** Fenced code block — dark, language label + copy, horizontal scroll. */
export function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <View style={styles.codeWrap}>
      <View style={styles.codeHeader}>
        <Text style={styles.codeLang}>{lang}</Text>
        <Touchable
          haptic="light"
          onPress={async () => {
            await Clipboard.setStringAsync(code).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}
        >
          <Icon name={copied ? 'check' : 'copy'} size={14} color={copied ? c.accent : c.codeLabel} />
          <Text style={{ fontSize: 12, fontWeight: '600', color: copied ? c.accent : c.codeLabel }}>
            {copied ? t('common.copied') : t('chat.actionCopy')}
          </Text>
        </Touchable>
      </View>
      <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false} style={styles.codeScroll}>
        <View style={{ paddingHorizontal: 14, paddingVertical: 12 }}>
          {code.split('\n').map((ln, i) => (
            <Text key={i} style={[styles.codeLine, /^\s*\/\//.test(ln) && { color: c.codeComment }]}>
              {ln || ' '}
            </Text>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  codeWrap: {
    marginVertical: 12,
    marginRight: -16,
    borderTopLeftRadius: radius.md,
    borderBottomLeftRadius: radius.md,
    overflow: 'hidden',
    borderWidth: 1,
    borderRightWidth: 0,
    borderColor: c.hairline,
    backgroundColor: c.codeBg,
  },
  codeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 7,
    paddingHorizontal: 12,
    backgroundColor: c.codeHeader,
  },
  codeLang: { fontFamily: mono, fontSize: 11, color: c.codeLabel, letterSpacing: 0.4 },
  codeScroll: { backgroundColor: c.codeBg },
  codeLine: { fontFamily: mono, fontSize: 12.5, lineHeight: 21, color: c.codeText },
}));
