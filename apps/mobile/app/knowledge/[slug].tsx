/**
 * Knowledge doc detail — renders content_markdown through the chat markdown
 * renderer. Header actions: edit (own/editor docs → the native editor screen)
 * and version history (sheet with restore). Refetches on focus so returning
 * from the editor always shows the saved content.
 */

import React, { useCallback, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { canEditDoc, getDoc, docTags, type KnowledgeDoc } from '../../src/api/knowledge';
import { KnowledgeVersionsSheet } from '../../src/knowledge/versions-sheet';
import { Markdown } from '../../src/chat/markdown';
import { relativeTime } from '../../src/lib/format';
import { useT } from '../../src/lib/i18n';
import { EmptyState, Icon, ScreenHeader, Skeleton, Touchable } from '../../src/ui';
import { font, makeStyles, radius, useTheme } from '../../src/theme';

export default function KnowledgeDetail() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const params = useLocalSearchParams<{ slug: string; title?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [doc, setDoc] = useState<KnowledgeDoc | null | 'missing'>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);

  // Refetch on every focus — the editor and version restore both change the doc.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      (async () => {
        const d = await getDoc(String(params.slug));
        if (alive) setDoc(d ?? 'missing');
      })();
      return () => {
        alive = false;
      };
    }, [params.slug]),
  );

  const loaded = doc !== null && doc !== 'missing' ? doc : null;
  const title = loaded ? loaded.title : params.title ? String(params.title) : t('knowledge.doc');
  const editable = !!loaded && canEditDoc(loaded);

  const scopeLabel = loaded
    ? loaded.visibility === 'team'
      ? t('knowledge.scopeTeam')
      : loaded.access === 'owner'
        ? t('knowledge.scopeMine')
        : t('knowledge.scopeShared')
    : '';

  return (
    <View style={[styles.root, { paddingTop: insets.top + 2 }]}>
      <ScreenHeader
        variant="compact"
        align="left"
        title={title}
        onLeading={() => router.back()}
        right={
          loaded ? (
            <View style={styles.headerActions}>
              {editable ? (
                <Touchable
                  haptic="none"
                  accessibilityLabel={t('knowledge.edit')}
                  onPress={() => router.push({ pathname: '/knowledge/edit', params: { slug: loaded.slug } })}
                  style={styles.headerBtn}
                >
                  <Icon name="pen" size={16} color={c.fgMuted} />
                </Touchable>
              ) : null}
              <Touchable
                haptic="none"
                accessibilityLabel={t('knowledge.history')}
                onPress={() => setVersionsOpen(true)}
                style={styles.headerBtn}
              >
                <Icon name="clock" size={16} color={c.fgMuted} />
              </Touchable>
            </View>
          ) : undefined
        }
      />

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
          <Text style={styles.metaLine}>
            {[scopeLabel, doc.space, relativeTime(doc.updated_at)].filter(Boolean).join(' · ')}
          </Text>
          {docTags(doc).length > 0 && (
            <View style={styles.tagRow}>
              {docTags(doc).map((tag) => (
                <View key={tag} style={styles.tag}>
                  <Text style={styles.tagText}>{tag}</Text>
                </View>
              ))}
            </View>
          )}
          <Markdown source={doc.content_markdown || doc.summary || ''} />
        </ScrollView>
      )}

      {loaded ? (
        <KnowledgeVersionsSheet
          doc={loaded}
          canRestore={editable}
          visible={versionsOpen}
          onClose={() => setVersionsOpen(false)}
          onRestored={setDoc}
        />
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.bg },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 8 },
  headerBtn: { width: 30, height: 30, borderRadius: 15, backgroundColor: c.surfaceMuted, alignItems: 'center', justifyContent: 'center' },

  docTitle: { fontSize: font.large, fontWeight: '700', color: c.fg, lineHeight: 32, marginTop: 6, marginBottom: 4 },
  metaLine: { fontSize: font.caption, color: c.fgFaint, marginBottom: 10 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 14 },
  tag: { backgroundColor: c.accentTint, borderRadius: radius.full, paddingVertical: 3, paddingHorizontal: 10 },
  tagText: { fontSize: font.caption, color: c.accentDeep, fontWeight: '600' },
}));
