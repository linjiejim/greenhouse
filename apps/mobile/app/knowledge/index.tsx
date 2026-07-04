/**
 * Knowledge list — read-only browse of the team knowledge base. Header with
 * back + title, a search field (debounced server-side search), and a FlatList
 * of doc rows (title, summary, space + visibility + updated time).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { listDocs, type KnowledgeDoc } from '../../src/api/knowledge';
import { shortTime } from '../../src/lib/format';
import { useT } from '../../src/lib/i18n';
import { EmptyState, Field, Icon, ScreenHeader, Skeleton, Tile, Touchable } from '../../src/ui';
import { font, makeStyles, radius, useTheme } from '../../src/theme';

export default function KnowledgeList() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [docs, setDocs] = useState<KnowledgeDoc[] | null>(null);
  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (q: string) => {
    const rows = await listDocs({ search: q.trim() || undefined });
    setDocs(rows);
  }, []);

  useEffect(() => {
    load('');
  }, [load]);

  const onSearch = useCallback(
    (v: string) => {
      setSearch(v);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => load(v), 300);
    },
    [load],
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(search);
    setRefreshing(false);
  }, [load, search]);

  return (
    <View style={[styles.root, { paddingTop: insets.top + 2 }]}>
      <ScreenHeader variant="large" title={t('knowledge.title')} onLeading={() => router.back()} />

      <View style={{ paddingHorizontal: 16, paddingBottom: 10 }}>
        <Field icon="search" placeholder={t('knowledge.searchPlaceholder')} value={search} onChangeText={onSearch} autoCapitalize="none" />
      </View>

      {docs === null ? (
        <View style={{ paddingHorizontal: 16, gap: 10 }}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} style={{ height: 74, borderRadius: radius.lg }} />
          ))}
        </View>
      ) : (
        <FlatList
          data={docs}
          keyExtractor={(d) => String(d.id)}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24 }}
          refreshing={refreshing}
          onRefresh={onRefresh}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <EmptyState icon="book" title={search ? t('knowledge.emptySearch') : t('knowledge.empty')} sub={search ? t('knowledge.emptySearchHint') : t('knowledge.emptyHint')} />
          }
          renderItem={({ item }) => <DocRow doc={item} onPress={() => router.push({ pathname: '/knowledge/[slug]', params: { slug: item.slug, title: item.title } })} />}
        />
      )}
    </View>
  );
}

function DocRow({ doc, onPress }: { doc: KnowledgeDoc; onPress: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <Touchable onPress={onPress} style={styles.row} pressedStyle={{ opacity: 0.7 }}>
      <Tile icon={doc.visibility === 'private' ? 'lock' : 'book'} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={styles.rowTitle}>
          {doc.title}
        </Text>
        {doc.summary ? (
          <Text numberOfLines={1} style={styles.rowSummary}>
            {doc.summary}
          </Text>
        ) : null}
        <View style={styles.rowMeta}>
          {doc.space ? <Text style={styles.rowMetaText}>{doc.space}</Text> : null}
          <Text style={styles.rowMetaText}>{shortTime(doc.updated_at)}</Text>
        </View>
      </View>
      <Icon name="chevR" size={16} color={c.fgFaint} />
    </Touchable>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 16, paddingBottom: 8 },
  backBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginLeft: -8 },
  title: { fontSize: font.displaySm, fontWeight: '700', color: c.fg, letterSpacing: -0.5 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: c.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.hairline,
    padding: 13,
    marginBottom: 10,
  },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: c.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: { fontSize: font.body, fontWeight: '600', color: c.fg },
  rowSummary: { fontSize: font.small, color: c.fgMuted, marginTop: 3, lineHeight: 18 },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 5 },
  rowMetaText: { fontSize: font.caption, color: c.fgFaint },
}));
