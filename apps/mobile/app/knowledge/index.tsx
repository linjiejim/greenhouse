/**
 * Knowledge list — browse the knowledge base. Header with back + title, a
 * search field (debounced server-side search), scope tabs (all / team /
 * personal / shared-with-me → the API's `visibility` filter), and a FlatList
 * of doc rows (title, summary, space + updated time, per-scope icon).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { listDocs, type KnowledgeDoc, type KnowledgeScope } from '../../src/api/knowledge';
import { shortTime } from '../../src/lib/format';
import { useT } from '../../src/lib/i18n';
import { EmptyState, Field, Icon, ScreenHeader, Segmented, Skeleton, Tile, Touchable, type IconName } from '../../src/ui';
import { font, makeStyles, radius, useTheme } from '../../src/theme';

export default function KnowledgeList() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [docs, setDocs] = useState<KnowledgeDoc[] | null>(null);
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<KnowledgeScope>('all');
  const [refreshing, setRefreshing] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against a slow response landing after the user switched scope/search.
  const requestSeq = useRef(0);

  const load = useCallback(async (q: string, s: KnowledgeScope) => {
    const seq = ++requestSeq.current;
    const rows = await listDocs({ search: q.trim() || undefined, scope: s });
    if (seq === requestSeq.current) setDocs(rows);
  }, []);

  useEffect(() => {
    load('', 'all');
  }, [load]);

  const onSearch = useCallback(
    (v: string) => {
      setSearch(v);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => load(v, scope), 300);
    },
    [load, scope],
  );

  const onScope = useCallback(
    (s: KnowledgeScope) => {
      setScope(s);
      setDocs(null);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      load(search, s);
    },
    [load, search],
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(search, scope);
    setRefreshing(false);
  }, [load, search, scope]);

  return (
    <View style={[styles.root, { paddingTop: insets.top + 2 }]}>
      <ScreenHeader variant="large" title={t('knowledge.title')} onLeading={() => router.back()} />

      <View style={{ paddingHorizontal: 16, paddingBottom: 10, gap: 10 }}>
        <Field icon="search" placeholder={t('knowledge.searchPlaceholder')} value={search} onChangeText={onSearch} autoCapitalize="none" />
        <Segmented<KnowledgeScope>
          items={[
            { id: 'all', label: t('knowledge.scopeAll') },
            { id: 'team', label: t('knowledge.scopeTeam') },
            { id: 'private', label: t('knowledge.scopeMine') },
            { id: 'shared', label: t('knowledge.scopeShared') },
          ]}
          value={scope}
          onChange={onScope}
        />
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

/** Team docs read as books; my private docs as locks; docs shared to me as shares. */
function docScopeIcon(doc: KnowledgeDoc): IconName {
  if (doc.visibility === 'team') return 'book';
  return doc.access === 'owner' ? 'lock' : 'share';
}

function DocRow({ doc, onPress }: { doc: KnowledgeDoc; onPress: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  return (
    <Touchable onPress={onPress} style={styles.row} pressedStyle={{ opacity: 0.7 }}>
      <Tile icon={docScopeIcon(doc)} />
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
          {doc.access === 'reader' ? <Text style={styles.rowMetaText}>{t('knowledge.readOnly')}</Text> : null}
          <Text style={styles.rowMetaText}>{shortTime(doc.updated_at)}</Text>
        </View>
      </View>
      <Icon name="chevR" size={16} color={c.fgFaint} />
    </Touchable>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.bg },

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
  rowTitle: { fontSize: font.body, fontWeight: '600', color: c.fg },
  rowSummary: { fontSize: font.small, color: c.fgMuted, marginTop: 3, lineHeight: 18 },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 5 },
  rowMetaText: { fontSize: font.caption, color: c.fgFaint },
}));
