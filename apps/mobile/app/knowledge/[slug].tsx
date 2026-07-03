/**
 * Knowledge doc detail — renders content_markdown through the chat markdown
 * renderer (read-only).
 */

import React, { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getDoc, docTags, type KnowledgeDoc } from '../../src/api/knowledge';
import { Markdown } from '../../src/chat/markdown';
import { useT } from '../../src/lib/i18n';
import { EmptyState, Icon, Skeleton, Touchable } from '../../src/ui';
import { makeStyles, radius, useTheme } from '../../src/theme';

export default function KnowledgeDetail() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const params = useLocalSearchParams<{ slug: string; title?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [doc, setDoc] = useState<KnowledgeDoc | null | 'missing'>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const d = await getDoc(String(params.slug));
      if (alive) setDoc(d ?? 'missing');
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const title = doc && doc !== 'missing' ? doc.title : params.title ? String(params.title) : t('knowledge.doc');

  return (
    <View style={[styles.root, { paddingTop: insets.top + 2 }]}>
      <View style={styles.header}>
        <Touchable haptic="none" onPress={() => router.back()} style={styles.backBtn} hitSlop={8}>
          <Icon name="back" size={23} color={c.fg} />
        </Touchable>
        <Text numberOfLines={1} style={styles.headerTitle}>
          {title}
        </Text>
      </View>

      {doc === null ? (
        <View style={{ paddingHorizontal: 16, gap: 12, paddingTop: 8 }}>
          <Skeleton style={{ height: 28, width: '70%', borderRadius: 8 }} />
          <Skeleton style={{ height: 16, borderRadius: 8 }} />
          <Skeleton style={{ height: 16, borderRadius: 8 }} />
          <Skeleton style={{ height: 16, width: '85%', borderRadius: 8 }} />
        </View>
      ) : doc === 'missing' ? (
        <EmptyState icon="book" title={t('knowledge.missing')} sub={t('knowledge.missingHint')} />
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 32 }} showsVerticalScrollIndicator={false}>
          <Text style={styles.docTitle}>{doc.title}</Text>
          {docTags(doc).length > 0 && (
            <View style={styles.tagRow}>
              {docTags(doc).map((t) => (
                <View key={t} style={styles.tag}>
                  <Text style={styles.tagText}>{t}</Text>
                </View>
              ))}
            </View>
          )}
          <Markdown source={doc.content_markdown || doc.summary || ''} />
        </ScrollView>
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 16, paddingBottom: 8 },
  backBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginLeft: -8 },
  headerTitle: { flex: 1, fontSize: 16, fontWeight: '700', color: c.fg },

  docTitle: { fontSize: 24, fontWeight: '700', color: c.fg, lineHeight: 32, marginTop: 6, marginBottom: 10 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 14 },
  tag: { backgroundColor: c.accentTint, borderRadius: radius.full, paddingVertical: 3, paddingHorizontal: 10 },
  tagText: { fontSize: 12, color: c.accentDeep, fontWeight: '600' },
}));
