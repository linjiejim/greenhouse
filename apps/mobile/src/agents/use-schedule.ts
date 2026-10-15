import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import { schedules, createSchedule, updateSchedule } from '../api/always-on';
import { useResource } from '../data/use-resource';
import { useAuth } from '../store/auth';
import { useT } from '../lib/i18n';
import { alertError } from '../ui/dialogs';

export function useSchedule(agent: string, id?: string) {
  const t = useT();
  const router = useRouter();
  const nav = useNavigation();
  const zone = useAuth((s) => s.user?.timezone ?? 'Asia/Shanghai');
  const resource = useResource(useCallback(() => schedules(agent), [agent]));
  const [draft, setDraft] = useState({ name: '', brief: '', cron: '0 9 * * *', timezone: zone, quiet: false });
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
    if (ready || !resource.data) return;
    const schedule = resource.data.items.find((s) => s.id === id);
    if (!schedule) return;
    const value = {
      name: schedule.name,
      brief: schedule.brief,
      cron: schedule.cron,
      timezone: schedule.timezone,
      quiet: schedule.quiet,
    };
    setInitial(value);
    setDraft(value);
    setReady(true);
  }, [id, ready, resource.data]);
  const dirty = !done && JSON.stringify(draft) !== JSON.stringify(initial);
  const valid =
    ready &&
    !!draft.name.trim() &&
    draft.name.trim().length <= 80 &&
    !!draft.brief.trim() &&
    draft.brief.trim().length <= 2000 &&
    draft.cron.trim().length >= 9 &&
    draft.cron.length <= 100 &&
    !!draft.timezone &&
    draft.timezone.length <= 64;
  const save = async () => {
    if (!valid || pending.current) return;
    const current = resource.captureWrite();
    pending.current = true;
    setSaving(true);
    const changes: Partial<typeof draft> = { ...draft };
    for (const key of Object.keys(draft) as (keyof typeof draft)[]) {
      if (draft[key] === initial[key]) delete changes[key];
    }
    const result = id ? await updateSchedule(id, changes) : await createSchedule({ ...draft, agent_id: agent });
    pending.current = false;
    if (!current()) return;
    setSaving(false);
    if (result.ok) {
      Keyboard.dismiss();
      setDone(true);
    } else alertError(t('work.saveFailed'), undefined, result.message);
  };
  return {
    resource,
    draft,
    ready,
    dirty,
    saving,
    canSave: valid && (!id || dirty),
    save,
    change: <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) =>
      setDraft((old) => ({ ...old, [key]: value })),
  };
}
