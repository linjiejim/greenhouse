import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import { agentMemories, createMemory, updateMemory } from '../api/agents';
import { useResource } from '../data/use-resource';
import { useT } from '../lib/i18n';
import { alertError } from '../ui/dialogs';

export function useMemory(agent: string, id?: string) {
  const t = useT();
  const router = useRouter();
  const nav = useNavigation();
  const r = useResource(useCallback(() => agentMemories(agent), [agent]));
  const [draft, setDraft] = useState({ title: '', content: '' });
  const [initial, setInitial] = useState(draft);
  const [ready, setReady] = useState(!id);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const pending = useRef(false);
  useEffect(() => nav.addListener('beforeRemove', () => Keyboard.dismiss()), [nav]);
  useEffect(() => {
    if (done) router.back();
  }, [done, router]);
  useEffect(() => {
    if (ready || !r.data) return;
    const item = r.data.items.find((memory) => memory.id === id);
    if (!item) return;
    const value = { title: item.title, content: item.content };
    setInitial(value);
    setDraft(value);
    setReady(true);
  }, [id, ready, r.data]);
  const dirty = !done && JSON.stringify(draft) !== JSON.stringify(initial);
  const canSave =
    ready &&
    !!draft.title.trim() &&
    draft.title.trim().length <= 120 &&
    draft.content.length <= 4000 &&
    dirty &&
    !saving;
  const save = async () => {
    if (!canSave || pending.current) return;
    const current = r.captureWrite();
    pending.current = true;
    setSaving(true);
    const input = { title: draft.title.trim(), content: draft.content };
    const result = id ? await updateMemory(agent, id, input) : await createMemory(agent, input);
    pending.current = false;
    if (!current()) return;
    setSaving(false);
    if (result.ok) {
      Keyboard.dismiss();
      setDone(true);
    } else alertError(t('work.saveFailed'), undefined, result.message);
  };
  return {
    r,
    draft,
    change: (key: keyof typeof draft, value: string) => setDraft((old) => ({ ...old, [key]: value })),
    ready,
    dirty,
    canSave,
    saving,
    save,
  };
}
