/**
 * TagSelectorSheet — assign/remove tags for one session, plus inline create.
 * A search box (doubles as the create field), a checklist of the user's tags
 * (✓ when attached to this session), and a "Create …" row when the typed name
 * is new. Toggling writes through POST/DELETE /api/sessions/:id/tags and reports
 * the new tag set to the caller via onChange.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import type { SessionTag } from '../shared/greenhouse-types';
import { useTags } from '../store/tags';
import { addTagToSession, removeTagFromSession, MAX_TAGS_PER_SESSION } from '../api/session-tags';
import { randomTagColor } from '../lib/tag-colors';
import { useT } from '../lib/i18n';
import { font, makeStyles, radius, useTheme } from '../theme';
import { BottomSheetScrollView, BottomSheetTextInput, Icon, Sheet, Touchable } from '../ui';
import { TagChip } from './tag-chip';

export function TagSelectorSheet({
  visible,
  onClose,
  sessionId,
  sessionTags,
  onChange,
  onManage,
}: {
  visible: boolean;
  onClose: () => void;
  sessionId: string;
  sessionTags: SessionTag[];
  onChange: (tags: SessionTag[]) => void;
  onManage?: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const tags = useTags((s) => s.tags);
  const load = useTags((s) => s.load);
  const createTag = useTags((s) => s.create);
  const [q, setQ] = useState('');
  // Synchronous in-flight lock: serializes tag mutations so each optimistic
  // update + revert operates on the committed tag set (never a stale closure).
  const busyRef = useRef(false);

  useEffect(() => {
    if (visible) void load();
    else setQ('');
  }, [visible, load]);

  const has = (id: number) => sessionTags.some((x) => x.id === id);
  const query = q.trim();
  const lc = query.toLowerCase();
  const filtered = query ? tags.filter((x) => x.name.toLowerCase().includes(lc)) : tags;
  const exact = tags.some((x) => x.name.toLowerCase() === lc);

  const atLimit = () => {
    if (sessionTags.length >= MAX_TAGS_PER_SESSION) {
      Alert.alert(t('tags.limitPerSession', { n: MAX_TAGS_PER_SESSION }));
      return true;
    }
    return false;
  };

  async function toggle(tag: SessionTag) {
    if (busyRef.current) return;
    const on = has(tag.id);
    if (!on && atLimit()) return;
    busyRef.current = true;
    // `prev` is the committed set (the lock guarantees no concurrent op mutated it),
    // so reverting to it on failure is always correct.
    const prev = sessionTags;
    onChange(on ? prev.filter((x) => x.id !== tag.id) : [...prev, tag]);
    try {
      const ok = on
        ? await removeTagFromSession(sessionId, tag.id)
        : (await addTagToSession(sessionId, tag.id)).ok;
      if (!ok) onChange(prev);
    } finally {
      busyRef.current = false;
    }
  }

  async function createAndAdd() {
    if (busyRef.current || !query || atLimit()) return;
    busyRef.current = true;
    try {
      const r = await createTag(query, randomTagColor());
      if (!r.ok || !r.tag) {
        Alert.alert(r.error?.includes('exists') ? t('tags.duplicate') : t('tags.createFailed'));
        return;
      }
      const prev = sessionTags;
      onChange([...prev, r.tag]);
      setQ('');
      const res = await addTagToSession(sessionId, r.tag.id);
      if (!res.ok) onChange(prev);
    } finally {
      busyRef.current = false;
    }
  }

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={t('tags.sessionTags')}
      heightPct={64}
      headerRight={
        onManage ? (
          <Touchable haptic="none" onPress={onManage} style={styles.manageBtn}>
            <Icon name="gear" size={16} color={c.fgMuted} />
          </Touchable>
        ) : undefined
      }
    >
      <View style={styles.searchWrap}>
        <View style={styles.search}>
          <Icon name="search" size={17} color={c.fgMuted} />
          <BottomSheetTextInput
            value={q}
            onChangeText={setQ}
            placeholder={t('tags.searchOrCreate')}
            placeholderTextColor={c.fgFaint}
            style={styles.searchInput}
            autoCapitalize="none"
            returnKeyType="done"
            onSubmitEditing={() => {
              if (query && !exact) void createAndAdd();
            }}
          />
        </View>
      </View>
      <BottomSheetScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 28 }}
        keyboardShouldPersistTaps="handled"
      >
        {filtered.map((tag) => (
          <Touchable
            key={tag.id}
            haptic="selection"
            onPress={() => toggle(tag)}
            pressedStyle={{ opacity: 0.7 }}
            style={[styles.row, has(tag.id) && styles.rowOn]}
          >
            <View style={styles.check}>
              {has(tag.id) ? <Icon name="check" size={18} color={c.accent} sw={2.4} /> : <View style={styles.emptyCheck} />}
            </View>
            <TagChip tag={tag} />
          </Touchable>
        ))}
        {query && !exact ? (
          <Touchable haptic="light" onPress={createAndAdd} pressedStyle={{ opacity: 0.7 }} style={styles.createRow}>
            <Icon name="plus" size={16} color={c.accent} />
            <Text style={styles.createText}>{t('tags.create', { name: query })}</Text>
          </Touchable>
        ) : null}
        {!filtered.length && !query ? <Text style={styles.empty}>{t('tags.none')}</Text> : null}
      </BottomSheetScrollView>
    </Sheet>
  );
}

const useStyles = makeStyles((c) => ({
  manageBtn: { width: 30, height: 30, borderRadius: 15, backgroundColor: c.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  searchWrap: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: c.surfaceMuted, borderRadius: radius.md, paddingHorizontal: 12, height: 40 },
  searchInput: { flex: 1, fontSize: font.body, color: c.fg, padding: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 6, borderRadius: radius.md },
  rowOn: { backgroundColor: c.accentTint },
  check: { width: 20, alignItems: 'center', justifyContent: 'center' },
  emptyCheck: { width: 17, height: 17, borderRadius: 9, borderWidth: 1.5, borderColor: c.hairlineStrong },
  createRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 11, paddingHorizontal: 6, marginTop: 4, borderTopWidth: 1, borderTopColor: c.hairline },
  createText: { fontSize: font.body, fontWeight: '600', color: c.accent },
  empty: { fontSize: font.small, color: c.fgFaint, textAlign: 'center', paddingVertical: 24 },
}));
