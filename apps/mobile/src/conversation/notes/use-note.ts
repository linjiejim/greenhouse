import { useEffect, useRef, useState } from 'react';
import { Keyboard } from 'react-native';
import { useIsFocused, useNavigation, useRouter } from 'expo-router';
import { patch, post, seg } from '../../api/client';
import { captureIdentity } from '../../data/identity';
import { getHandoff } from '../../lib/handoff';
import { useT } from '../../lib/i18n';
import type { Note } from '../../shared/contract';
import { alertError } from '../../ui/dialogs';

/** Note edits belong to a route, never a global prompt above unrelated pages. */
export function useNote(conversation: string, key?: string) {
  const [snapshot] = useState(() => getHandoff<Note>(key, 'note'));
  const [current] = useState(captureIdentity);
  const ready = !key || snapshot?.conversation_id === conversation;
  const initial = snapshot?.body ?? '';
  const [body, setBody] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const focused = useIsFocused();
  const visible = useRef(focused);
  visible.current = focused;
  const pending = useRef(false);
  const mounted = useRef(true);
  const router = useRouter();
  const navigation = useNavigation();
  const t = useT();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => navigation.addListener('beforeRemove', () => Keyboard.dismiss()), [navigation]);
  useEffect(() => {
    if (done && focused) router.back();
  }, [done, focused, router]);
  const dirty = !done && body !== initial;
  const canSave = !!conversation && ready && focused && dirty && !!body.trim() && body.length <= 20000 && !saving;
  const save = async () => {
    if (!mounted.current || !visible.current || !current() || !canSave || pending.current) return;
    pending.current = true;
    setSaving(true);
    const base = `/api/conversations/${seg(conversation)}/notes`;
    const result = snapshot
      ? await patch<Note>(`${base}/${seg(snapshot.id)}`, { body })
      : await post<Note>(base, { body });
    pending.current = false;
    if (!mounted.current || !current()) return;
    setSaving(false);
    if (result.ok) {
      if (visible.current) Keyboard.dismiss();
      setDone(true);
    } else if (visible.current) alertError(t('work.saveFailed'), undefined, result.message);
  };
  return { ready, body, setBody, saving, dirty, canSave, save };
}
