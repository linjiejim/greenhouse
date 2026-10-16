import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard } from 'react-native';
import { useNavigation } from 'expo-router';
import { listAgents } from '../api/agents';
import { post, seg } from '../api/client';
import { useResource } from '../data/use-resource';
import { useT } from '../lib/i18n';
import { alertError } from '../ui/dialogs';
import { useLeaveSheetTo } from '../ui/sheet-chrome';

export function useRecordHandoff(record: string) {
  const t = useT();
  const nav = useNavigation();
  const leaveTo = useLeaveSheetTo();
  const agents = useResource(useCallback(() => listAgents(), []));
  const [agent, setAgent] = useState('');
  const [brief, setBrief] = useState('');
  const [saving, setSaving] = useState(false);
  const [run, setRun] = useState<string | null>(null);
  const pending = useRef(false);
  useEffect(() => nav.addListener('beforeRemove', () => Keyboard.dismiss()), [nav]);
  useEffect(() => {
    if (run) leaveTo({ pathname: '/runs/[id]', params: { id: run } });
  }, [run, leaveTo]);
  const options = (agents.data?.items ?? []).filter((a) => !a.archived_at);
  const selected = agent || options[0]?.id || '';
  const canSave = !run && options.some((a) => a.id === selected) && !!brief.trim() && brief.trim().length <= 4000;
  const save = async () => {
    if (!canSave || pending.current) return;
    const current = agents.captureWrite();
    pending.current = true;
    setSaving(true);
    const result = await post<{ run_id: string }>(`/api/tables/records/${seg(record)}/handoff`, {
      agent_id: selected,
      brief,
    });
    pending.current = false;
    if (!current()) return;
    setSaving(false);
    if (result.ok) {
      Keyboard.dismiss();
      setRun(result.data.run_id);
    } else alertError(t('work.saveFailed'), undefined, result.message);
  };
  return { agents, options, selected, setAgent, brief, setBrief, saving, dirty: !run && !!brief, canSave, save };
}
