import { useEffect, useRef, useState } from 'react';
import { Keyboard } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import { post } from '../api/client';
import { updateMe } from '../api/auth';
import { captureIdentity } from '../data/identity';
import { useT } from '../lib/i18n';
import { useAuth } from '../store/auth';
import { alertError } from '../ui/dialogs';

export function useAccount(password: boolean) {
  const t = useT();
  const router = useRouter();
  const nav = useNavigation();
  const initial = useAuth((s) => s.user?.about ?? '');
  const [draft, setDraft] = useState({ about: initial, current: '', next: '', confirm: '' });
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const pending = useRef(false);
  const dirty = !done && (password ? !!(draft.current || draft.next || draft.confirm) : draft.about !== initial);
  const canSave =
    !saving &&
    dirty &&
    (password
      ? !!draft.current &&
        draft.current.length <= 256 &&
        draft.next.length >= 8 &&
        draft.next.length <= 256 &&
        draft.next === draft.confirm
      : draft.about.length <= 4000);
  useEffect(() => nav.addListener('beforeRemove', () => Keyboard.dismiss()), [nav]);
  useEffect(() => {
    if (done) router.back();
  }, [done, router]);
  const save = async () => {
    if (!canSave || pending.current) return;
    const current = captureIdentity();
    pending.current = true;
    setSaving(true);
    const result = password
      ? await post<void>('/api/me/password', { current_password: draft.current, new_password: draft.next })
      : await updateMe({ about: draft.about });
    pending.current = false;
    if (!current()) return;
    setSaving(false);
    if (!result.ok) {
      alertError(
        t('work.saveFailed'),
        result.code === 'invalid_credentials' ? t('integration.wrongPassword') : undefined,
        result.message,
      );
      return;
    }
    Keyboard.dismiss();
    if (password) {
      setDraft({ about: '', current: '', next: '', confirm: '' });
      await useAuth.getState().logout();
    } else {
      if (result.data) useAuth.getState().setUser(result.data);
      setDone(true);
    }
  };
  return {
    password,
    draft,
    dirty,
    canSave,
    saving,
    save,
    change: (key: keyof typeof draft, value: string) => setDraft((old) => ({ ...old, [key]: value })),
  };
}
