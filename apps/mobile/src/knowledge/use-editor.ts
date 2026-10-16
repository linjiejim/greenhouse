import { captureIdentity } from '../data/identity';
import { useEffect, useRef, useState } from 'react';
import { Keyboard } from 'react-native';
import { useRouter, useNavigation } from 'expo-router';
import { getHandoff } from '../lib/handoff';
import type { KnowledgeDoc } from '../shared/contract';
import { doc, saveDoc, heartbeat, leaveDoc } from '../api/knowledge';
import { useT } from '../lib/i18n';
import { alertError, confirmAction } from '../ui/dialogs';
export function useEditor(k?: string) {
  const [snapshot, setSnapshot] = useState(() => getHandoff<KnowledgeDoc>(k, 'doc'));
  const [title, setTitle] = useState(snapshot?.title ?? '');
  const [body, setBody] = useState(snapshot?.content ?? '');
  const [saving, setSaving] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const draft = useRef({ title, body });
  draft.current = { title, body };
  const busy = useRef(false);
  const t = useT();
  const router = useRouter();
  const navigation = useNavigation();
  useEffect(() => navigation.addListener('beforeRemove', () => Keyboard.dismiss()), [navigation]);
  useEffect(() => {
    if (!snapshot) return;
    const current = captureIdentity();
    void heartbeat(snapshot.id, true);
    const timer = setInterval(() => {
      if (current()) void heartbeat(snapshot.id, true);
    }, 20000);
    return () => {
      clearInterval(timer);
      if (current()) void leaveDoc(snapshot.id);
    };
  }, [snapshot]);
  const reload = async () => {
    if (
      !snapshot ||
      ((title !== snapshot.title || body !== snapshot.content) &&
        !(await confirmAction({
          title: t('common.discardTitle'),
          message: t('common.discardHint'),
          confirmLabel: t('work.reload'),
          destructive: true,
        })))
    )
      return;
    const current = captureIdentity();
    const result = await doc(snapshot.id);
    if (!current()) return;
    if (!result.ok) {
      alertError(t('work.loadFailed'), undefined, result.message);
      return;
    }
    Keyboard.dismiss();
    setSnapshot(result.data);
    setTitle(result.data.title);
    setBody(result.data.content);
    setEpoch((n) => n + 1);
  };
  const save = async () => {
    if (!snapshot || busy.current) return;
    busy.current = true;
    setSaving(true);
    const current = captureIdentity();
    const result = await saveDoc(
      snapshot.id,
      snapshot.version,
      title.trim(),
      body === snapshot.content ? undefined : body,
    );
    busy.current = false;
    if (!current()) return;
    setSaving(false);
    if (!result.ok) {
      alertError(t(result.code === 'stale_version' ? 'work.stale' : 'work.saveFailed'), undefined, result.message);
      return;
    }
    Keyboard.dismiss();
    const unchanged = draft.current.title === title && draft.current.body === body;
    setSnapshot(result.data);
    setTitle((current) => (current === title ? result.data.title : current));
    setBody((current) => (current === body ? result.data.content : current));
    if (unchanged) requestAnimationFrame(() => router.back());
  };
  return {
    snapshot,
    title,
    body,
    setTitle,
    setBody,
    saving,
    epoch,
    save,
    reload,
    dirty: !!snapshot && (title !== snapshot.title || body !== snapshot.content),
  };
}
