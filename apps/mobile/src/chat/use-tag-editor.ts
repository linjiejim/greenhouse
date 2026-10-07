/**
 * The behaviour behind the tag editor sheet on both platforms
 * (app/sheets/tag-editor.tsx — SwiftUI, tag-editor.android.tsx — Material):
 * name + color state, dirty / can-save, `save` (create or update through the
 * tags store; a tag created from a conversation's tag sheet is attached to it
 * right away — if that fails the tag stays created and the user is told) and
 * `confirmDelete`. The native name field owns its text: `readName` returns it
 * (its change event is async), `name` mirrors it for rendering.
 */

import { useState } from 'react';
import { useRouter } from 'expo-router';
import type { SessionTag } from '../shared/greenhouse-types';
import { useTags, type ToggleResult } from '../store/tags';
import { MAX_TAGS_PER_SESSION, MAX_TAGS_PER_USER } from '../api/session-tags';
import { randomTagColor, tagHex } from '../lib/tag-colors';
import { useT } from '../lib/i18n';
import { alertError, confirmAction } from '../ui/dialogs';

export function useTagEditor(tag: SessionTag | undefined, sessionId: string | undefined, readName: () => string | undefined) {
  const t = useT();
  const router = useRouter();
  const create = useTags((s) => s.create);
  const update = useTags((s) => s.update);
  const remove = useTags((s) => s.remove);
  const toggleSessionTag = useTags((s) => s.toggleSessionTag);

  const [name, setName] = useState(tag?.name ?? '');
  // (an off-palette / missing stored color reads as the default gray, not as an edit)
  const [color, setColor] = useState<string>(() => (tag ? tagHex(tag.color) : randomTagColor()));
  const [busy, setBusy] = useState(false);

  const isDirty = (n: string) => !tag || n !== tag.name || color.toLowerCase() !== tagHex(tag.color).toLowerCase();
  const trimmed = name.trim();
  const canSave = !!trimmed && isDirty(trimmed);
  // unsaved edits: the chrome blocks dismissing and confirms ✕
  const dirty = tag ? isDirty(trimmed) : !!trimmed;

  const save = async () => {
    const value = (readName() ?? name).trim();
    if (busy || !value || !isDirty(value)) return;
    setBusy(true);
    let res: { ok: boolean; error?: string };
    let attach: ToggleResult | null = null;
    if (tag) {
      res = await update(tag.id, { name: value, color });
    } else {
      const r = await create(value, color);
      res = r;
      // attach to the conversation the editor was opened from
      if (r.ok && r.tag && sessionId) attach = await toggleSessionTag(sessionId, r.tag);
    }
    setBusy(false);
    if (!res.ok) {
      const err = res.error?.toLowerCase() ?? '';
      if (err.includes('exists')) alertError(t('tags.duplicate'));
      else if (err.startsWith('maximum')) alertError(t('tags.limitPerUser', { n: MAX_TAGS_PER_USER }));
      else alertError(tag ? t('tags.saveFailed') : t('tags.createFailed'));
      return;
    }
    router.back();
    // the tag exists either way — say so if it couldn't be attached
    if (attach === 'limit') alertError(t('tags.createdNotAttached'), t('tags.limitPerSession', { n: MAX_TAGS_PER_SESSION }));
    else if (attach === 'failed') alertError(t('tags.createdNotAttached'), t('tags.assignFailed'));
  };

  const confirmDelete = async () => {
    if (!tag || busy) return;
    const ok = await confirmAction({
      title: t('tags.deleteTitle'),
      message: t('tags.deleteHint', { name: tag.name }),
      confirmLabel: t('tags.delete'),
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    const removed = await remove(tag.id);
    setBusy(false);
    if (removed) router.back();
    else alertError(t('tags.deleteFailed'));
  };

  return { name, setName, color, setColor, busy, trimmed, canSave, dirty, save, confirmDelete };
}
