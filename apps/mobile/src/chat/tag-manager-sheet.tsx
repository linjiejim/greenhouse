/**
 * TagManagerSheet — the tag library: create / rename / recolor / delete.
 * A scrollable list of the user's tags (chip + edit + delete), each editable
 * inline (name field + color swatches), and a create form at the bottom with a
 * live preview. Writes go through the tags store (→ /api/session-tags).
 */

import React, { useEffect, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import type { SessionTag } from '../shared/greenhouse-types';
import { useTags } from '../store/tags';
import { TAG_COLORS } from '../lib/tag-colors';
import { useT } from '../lib/i18n';
import { font, makeStyles, radius, useTheme } from '../theme';
import { BottomSheetScrollView, BottomSheetTextInput, Icon, Sheet, Touchable } from '../ui';
import { TagChip } from './tag-chip';

function Swatches({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { colors: c } = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingVertical: 4 }}>
      {TAG_COLORS.map((col) => (
        <Touchable key={col} haptic="selection" onPress={() => onChange(col)} hitSlop={4}>
          <View
            style={{
              width: 26,
              height: 26,
              borderRadius: 13,
              backgroundColor: col,
              borderWidth: value === col ? 2.5 : 0,
              borderColor: c.fg,
            }}
          />
        </Touchable>
      ))}
    </View>
  );
}

export function TagManagerSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const tags = useTags((s) => s.tags);
  const load = useTags((s) => s.load);
  const create = useTags((s) => s.create);
  const update = useTags((s) => s.update);
  const remove = useTags((s) => s.remove);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState<string>(TAG_COLORS[0]);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<string>(TAG_COLORS[0]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (visible) void load();
    else {
      setEditingId(null);
      setNewName('');
      setNewColor(TAG_COLORS[0]);
    }
  }, [visible, load]);

  function startEdit(tag: SessionTag) {
    setEditingId(tag.id);
    setEditName(tag.name);
    setEditColor(tag.color || TAG_COLORS[0]);
  }

  function fail(error?: string) {
    Alert.alert(error?.includes('exists') ? t('tags.duplicate') : t('tags.createFailed'));
  }

  async function saveEdit() {
    const name = editName.trim();
    if (!name || editingId == null || busy) return;
    setBusy(true);
    const r = await update(editingId, { name, color: editColor });
    setBusy(false);
    if (!r.ok) return fail(r.error);
    setEditingId(null);
  }

  function confirmDelete(tag: SessionTag) {
    Alert.alert(t('tags.deleteTitle'), t('tags.deleteHint', { name: tag.name }), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('tags.delete'), style: 'destructive', onPress: () => void remove(tag.id) },
    ]);
  }

  async function createNew() {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    const r = await create(name, newColor);
    setBusy(false);
    if (!r.ok) return fail(r.error);
    setNewName('');
    setNewColor(TAG_COLORS[0]);
  }

  const canCreate = !!newName.trim() && !busy;

  return (
    <Sheet visible={visible} onClose={onClose} title={t('tags.manage')} heightPct={82}>
      <BottomSheetScrollView contentContainerStyle={{ padding: 16, paddingBottom: 36 }} keyboardShouldPersistTaps="handled">
        <Text style={styles.hint}>{t('tags.hint')}</Text>

        {tags.length === 0 ? <Text style={styles.empty}>{t('tags.none')}</Text> : null}

        {tags.map((tag) =>
          editingId === tag.id ? (
            <View key={tag.id} style={styles.editCard}>
              <View style={styles.field}>
                <BottomSheetTextInput
                  value={editName}
                  onChangeText={setEditName}
                  placeholder={t('tags.namePlaceholder')}
                  placeholderTextColor={c.fgFaint}
                  style={styles.fieldInput}
                />
              </View>
              <Swatches value={editColor} onChange={setEditColor} />
              <View style={styles.editActions}>
                <Touchable haptic="none" onPress={() => setEditingId(null)} style={styles.ghostBtn} pressedStyle={{ opacity: 0.7 }}>
                  <Text style={styles.ghostText}>{t('common.cancel')}</Text>
                </Touchable>
                <Touchable onPress={saveEdit} disabled={!editName.trim() || busy} style={[styles.saveBtn, (!editName.trim() || busy) && styles.disabled]}>
                  <Text style={styles.saveText}>{t('tags.save')}</Text>
                </Touchable>
              </View>
            </View>
          ) : (
            <View key={tag.id} style={styles.row}>
              <TagChip tag={tag} />
              <View style={{ flex: 1 }} />
              <Touchable haptic="none" onPress={() => startEdit(tag)} hitSlop={8} style={styles.iconBtn}>
                <Icon name="pen" size={16} color={c.fgMuted} />
              </Touchable>
              <Touchable haptic="none" onPress={() => confirmDelete(tag)} hitSlop={8} style={styles.iconBtn}>
                <Icon name="trash" size={16} color={c.fgMuted} />
              </Touchable>
            </View>
          ),
        )}

        <View style={styles.divider} />

        <Text style={styles.formLabel}>{t('tags.newTag')}</Text>
        <View style={styles.field}>
          <Icon name="bolt" size={17} color={c.fgMuted} />
          <BottomSheetTextInput
            value={newName}
            onChangeText={setNewName}
            placeholder={t('tags.namePlaceholder')}
            placeholderTextColor={c.fgFaint}
            style={styles.fieldInput}
          />
        </View>
        <Swatches value={newColor} onChange={setNewColor} />
        <View style={styles.previewRow}>
          <View style={styles.previewWrap}>
            <Text style={styles.previewLabel}>{t('tags.preview')}</Text>
            <TagChip tag={{ id: -1, name: newName.trim() || t('tags.newTag'), color: newColor }} />
          </View>
          <Touchable onPress={createNew} disabled={!canCreate} style={[styles.createBtn, !canCreate && styles.disabled]}>
            <Icon name="plus" size={15} color={c.onAccent} />
            <Text style={styles.createBtnText}>{t('tags.createBtn')}</Text>
          </Touchable>
        </View>
      </BottomSheetScrollView>
    </Sheet>
  );
}

const useStyles = makeStyles((c) => ({
  hint: { fontSize: font.caption, color: c.fgMuted, marginBottom: 12 },
  empty: { fontSize: font.small, color: c.fgFaint, textAlign: 'center', paddingVertical: 20 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 9 },
  iconBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },

  editCard: {
    backgroundColor: c.surfaceMuted,
    borderRadius: radius.lg,
    padding: 12,
    marginVertical: 6,
    gap: 6,
  },
  editActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 2 },
  ghostBtn: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: radius.md },
  ghostText: { fontSize: font.label, fontWeight: '600', color: c.fgMuted },
  saveBtn: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: radius.md, backgroundColor: c.accent },
  saveText: { fontSize: font.label, fontWeight: '600', color: c.onAccent },

  divider: { height: 1, backgroundColor: c.hairline, marginVertical: 16 },
  formLabel: { fontSize: font.caption, fontWeight: '600', color: c.fgMuted, marginBottom: 8 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: c.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.hairline,
    paddingHorizontal: 14,
    height: 48,
  },
  fieldInput: { flex: 1, fontSize: font.body, color: c.fg, padding: 0 },
  previewRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  previewWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  previewLabel: { fontSize: font.caption, color: c.fgFaint },
  createBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 9,
    paddingHorizontal: 16,
    borderRadius: radius.md,
    backgroundColor: c.accent,
  },
  createBtnText: { fontSize: font.label, fontWeight: '600', color: c.onAccent },
  disabled: { opacity: 0.5 },
}));
