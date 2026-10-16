/**
 * The one way to create or edit an Agent (AGNT-02, AGNT-05 资料), shared by both platforms'
 * forms (app/agents/edit.tsx — SwiftUI, edit.android.tsx — Material):
 *
 *  - new: pick a template from the gallery (the ones this workspace can serve: a researcher needs
 *    search, a knowledge keeper the knowledge module…) or start blank; the form is prefilled from
 *    the template's copy in the member's language; ✓ creates it and opens its Agent thread;
 *  - edit: the Agent's current name, plant and colour, role and instructions; ✓ saves a new
 *    version and goes back.
 *
 * The name is required and capped (AGENT_NAME_MAX); the server refuses a taken name
 * (`agent_name_taken`) or one Agent too many (`agent_limit`) — said in the form's words.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createAgent, getAgent, updateAgent } from '../api/agents';
import { createConversation } from '../api/conversations';
import { useT } from '../lib/i18n';
import { AGENT_TEMPLATES, type AgentTemplate } from '../shared/agent-templates';
import type { AgentAvatar, AgentDetail, Me } from '../shared/contract';
import { AGENT_NAME_MAX } from '../shared/contract';
import { usePrefs } from '../store/prefs';
import { useWorkspace } from '../store/workspace';
import { alertError } from '../ui/dialogs';
import { notifySuccess } from '../ui/haptics';
import { DEFAULT_PLANT, avatarTint, isPlantId, type PlantId, type PlantTint } from '../ui/plant-avatar/plant-ids';

export interface AgentDraft {
  template_key: string | null;
  name: string;
  role: string;
  instructions: string;
  plant: PlantId;
  tint: PlantTint;
}

/** The templates this member's workspace can serve (the web's gallery rule). */
export function availableTemplates(me: Me | null): AgentTemplate[] {
  if (!me) return [];
  return AGENT_TEMPLATES.filter((template) =>
    template.needs.every((need) => (need === 'search' ? !!me.capabilities.search : !!me.modules[need])),
  );
}

/** A template's one line, without the computer it cannot have here. */
export function templatePitch(template: AgentTemplate, me: Me | null, lang: 'zh' | 'en'): string {
  const copy = template.copy[lang];
  return template.usesComputer && !me?.capabilities.sandbox ? (copy.pitchNoComputer ?? copy.pitch) : copy.pitch;
}

export function draftFromTemplate(template: AgentTemplate | null, lang: 'zh' | 'en'): AgentDraft {
  const copy = template?.copy[lang];
  return {
    template_key: template?.key ?? null,
    name: copy?.name ?? '',
    role: copy?.role ?? '',
    instructions: copy?.instructions ?? '',
    plant: template?.plant ?? DEFAULT_PLANT,
    tint: 'plant',
  };
}

export function draftFromAgent(agent: AgentDetail): AgentDraft {
  const plant = agent.avatar.plant;
  return {
    template_key: agent.template_key,
    name: agent.name,
    role: agent.role,
    instructions: agent.instructions,
    plant: isPlantId(plant) ? plant : DEFAULT_PLANT,
    tint: avatarTint(agent.avatar),
  };
}

const avatarOf = (draft: AgentDraft): AgentAvatar => ({
  plant: draft.plant,
  ...(draft.tint !== 'plant' ? { tint: draft.tint } : {}),
});

export type FormOutcome = { kind: 'created'; conversationId: string | null; name: string } | { kind: 'saved' } | null;

export function useAgentForm(agentId: string | null) {
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [initial, setInitial] = useState<AgentDraft | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!agentId) return;
    setLoadFailed(false);
    const result = await getAgent(agentId);
    if (!result.ok) {
      setLoadFailed(true);
      return;
    }
    setAgent(result.data);
    const next = draftFromAgent(result.data);
    setDraft(next);
    setInitial(next);
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const choose = useCallback(
    (template: AgentTemplate | null) => {
      const next = draftFromTemplate(template, lang);
      setDraft(next);
      setInitial(next);
    },
    [lang],
  );

  const set = useCallback(<K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  }, []);

  const dirty = useMemo(() => {
    if (!draft || !initial) return false;
    return (Object.keys(draft) as (keyof AgentDraft)[]).some((key) => draft[key] !== initial[key]);
  }, [draft, initial]);
  const nameOk = !!draft && draft.name.trim().length > 0 && draft.name.trim().length <= AGENT_NAME_MAX;
  const canSave = !!draft && nameOk && !saving && (agentId ? dirty : true);

  /** Create or save; the outcome tells the screen where to go. */
  const save = useCallback(async (): Promise<FormOutcome> => {
    if (!draft || !nameOk || saving) return null;
    setSaving(true);
    const input = {
      name: draft.name.trim(),
      role: draft.role.trim(),
      instructions: draft.instructions,
      avatar: avatarOf(draft),
    };
    if (agentId) {
      const result = await updateAgent(agentId, input);
      setSaving(false);
      if (!result.ok) {
        alertError(t('agents.saveFailed'), problem(t, result.code, result.message));
        return null;
      }
      setAgent(result.data);
      useWorkspace.getState().patchAgent(result.data);
      notifySuccess();
      return { kind: 'saved' };
    }
    const result = await createAgent({ ...input, ...(draft.template_key ? { template_key: draft.template_key } : {}) });
    if (!result.ok) {
      setSaving(false);
      alertError(t('agents.createFailed'), problem(t, result.code, result.message));
      return null;
    }
    useWorkspace.getState().patchAgent(result.data);
    // Straight into its thread.
    const thread = await createConversation({ kind: 'direct', agent_id: result.data.id });
    setSaving(false);
    if (thread.ok) useWorkspace.getState().putConversation(thread.data);
    notifySuccess();
    return { kind: 'created', conversationId: thread.ok ? thread.data.id : null, name: result.data.name };
  }, [draft, nameOk, saving, agentId, t]);

  return { agent, loadFailed, retry: load, draft, choose, set, dirty, canSave, saving, nameOk, save, lang };
}

function problem(t: ReturnType<typeof useT>, code: string, message: string): string | undefined {
  if (code === 'agent_name_taken') return t('agents.nameTaken');
  if (code === 'agent_limit') return t('agents.limit');
  return message || undefined;
}
