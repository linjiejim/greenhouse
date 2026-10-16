/**
 * A new room, or people added to one (CONV-04), shared by both platforms' sheets
 * (app/new-room.tsx — SwiftUI, new-room.android.tsx — Material):
 *
 *  - new: an optional name, the people (the workspace directory, `/api/members`, filtered by the
 *    search), and which of my own Agents come along (an Agent comes only with its owner); two
 *    people make a direct message. ✓ creates it and opens it;
 *  - `room`: the people not in it yet, and my Agents not in it yet; ✓ adds them and closes.
 *
 * Refusals are the server's sentence (alertError).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { addMembers, createConversation } from '../api/conversations';
import { memberDirectory } from '../api/me';
import { useT } from '../lib/i18n';
import type { MemberSummary } from '../shared/contract';
import { useAuth } from '../store/auth';
import { useThreads } from '../store/threads';
import { useWorkspace } from '../store/workspace';
import { alertError } from '../ui/dialogs';

export function useNewRoom(roomId: string | null) {
  const t = useT();
  const me = useAuth((s) => s.user);
  const agents = useWorkspace((s) => s.agents);
  const members = useThreads((s) => (roomId ? s.threads[roomId]?.members : null));
  const [people, setPeople] = useState<MemberSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [bring, setBring] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    const result = await memberDirectory();
    if (result.ok) setPeople(result.data.items);
    else setFailed(true);
  }, []);
  useEffect(() => {
    void load();
    if (roomId) void useThreads.getState().refreshMembers(roomId);
  }, [load, roomId]);

  const inRoom = useMemo(() => new Set((members?.members ?? []).map((person) => person.id)), [members]);
  const agentsIn = useMemo(() => new Set((members?.agents ?? []).map((agent) => agent.id)), [members]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (people ?? []).filter(
      (person) =>
        person.id !== me?.id &&
        !inRoom.has(person.id) &&
        (!q || person.name.toLowerCase().includes(q) || person.email.toLowerCase().includes(q)),
    );
  }, [people, query, me?.id, inRoom]);
  const myAgents = useMemo(
    () => (agents ?? []).filter((agent) => !agent.archived_at && !agentsIn.has(agent.id)),
    [agents, agentsIn],
  );

  const toggle = useCallback(
    (id: string) => setPicked((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id])),
    [],
  );
  const toggleAgent = useCallback(
    (handle: string) => setBring((list) => (list.includes(handle) ? list.filter((x) => x !== handle) : [...list, handle])),
    [],
  );

  const canSave = !saving && (roomId ? picked.length + bring.length > 0 : picked.length > 0);
  const dirty = picked.length > 0 || bring.length > 0 || !!title.trim();

  /** Create or add; the new room's id (to open), `true` when people were added, null when it failed. */
  const save = useCallback(async (): Promise<string | true | null> => {
    if (!canSave) return null;
    setSaving(true);
    if (roomId) {
      const result = await addMembers(roomId, { member_ids: picked, agent_ids: bring });
      setSaving(false);
      if (!result.ok) {
        alertError(t('rooms.addFailed'), result.message || undefined);
        return null;
      }
      void useThreads.getState().refreshMembers(roomId);
      void useWorkspace.getState().refreshConversations();
      return true;
    }
    const result = await createConversation({
      kind: 'room',
      ...(title.trim() ? { title: title.trim() } : {}),
      member_ids: picked,
      agent_ids: bring,
    });
    setSaving(false);
    if (!result.ok) {
      alertError(t('rooms.createFailed'), result.message || undefined);
      return null;
    }
    useWorkspace.getState().putConversation(result.data);
    return result.data.id;
  }, [canSave, roomId, picked, bring, title, t]);

  return {
    people,
    failed,
    reload: load,
    rows,
    myAgents,
    query,
    setQuery,
    picked,
    toggle,
    bring,
    toggleAgent,
    title,
    setTitle,
    canSave,
    dirty,
    saving,
    save,
  };
}

/** The handle an Agent of mine is brought into a room with. */
export const agentHandle = (agent: { id: string; is_main: boolean }) => (agent.is_main ? 'main' : `agent:${agent.id}`);
