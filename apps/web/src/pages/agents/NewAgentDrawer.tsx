import { errorText } from '../../lib/errors';
import { useOverlayDraft } from '../../lib/useOverlayDraft';
/**
 * The one way to create an Agent (AGNT-02): pick a template or start blank, adjust, create. The
 * gallery hides templates whose needs the workspace cannot meet. A proposal from the main
 * Agent opens this same form, prefilled.
 */

import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { AGENT_TEMPLATES, type AgentTemplate } from '@greenhouse/types/agent-templates';
import { AGENT_INSTRUCTIONS_MAX, AGENT_NAME_MAX, AGENT_ROLE_MAX, type CreateAgentInput } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { Button, Field, FieldGroup, Input, Overlay, OverlayActions, TextArea } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import { useNotify } from '../../app/notify';
import { useMe } from '../../app/session';
import { useCreateAgent } from '../../data/agents';
import { useCreateConversation } from '../../data/conversations';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { AgentAvatar } from '../../shell/AgentAvatar';
import { PlantPicker } from './ProfileTab';

interface Draft {
  template_key?: string;
  name: string;
  role: string;
  instructions: string;
  plant: string;
  tint: string;
}

export function NewAgentDrawer({ prefill, onClose }: { prefill?: Partial<CreateAgentInput>; onClose: () => void }) {
  const { t, locale } = useI18n();
  const me = useMe();
  const notify = useNotify();
  const create = useCreateAgent();
  const openConversation = useCreateConversation();
  const [draft, setDraft] = useState<Draft | null>(
    prefill
      ? {
          template_key: prefill.template_key,
          name: prefill.name ?? '',
          role: prefill.role ?? '',
          instructions: prefill.instructions ?? '',
          plant: prefill.avatar?.plant ?? '',
          tint: prefill.avatar?.tint ?? '',
        }
      : null,
  );
  const [error, setError] = useState('');

  const dismiss = useOverlayDraft(draft, create.isPending || openConversation.isPending, onClose);
  const available = (template: AgentTemplate) =>
    template.needs.every((need) => (need === 'search' ? me.capabilities.search : me.modules[need]));
  const templates = AGENT_TEMPLATES.filter(available);
  const pitch = (template: AgentTemplate) => {
    const copy = template.copy[locale];
    return template.usesComputer && !me.capabilities.sandbox ? (copy.pitchNoComputer ?? copy.pitch) : copy.pitch;
  };

  const choose = (template: AgentTemplate | null) => {
    const copy = template?.copy[locale];
    setDraft({
      template_key: template?.key,
      name: copy?.name ?? '',
      role: copy?.role ?? '',
      instructions: copy?.instructions ?? '',
      plant: template?.plant ?? '',
      tint: '',
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    if (!draft.name.trim()) return setError(t('request.required', { name: t('agents.name') }));
    create.mutate(
      {
        ...(draft.template_key ? { template_key: draft.template_key } : {}),
        name: draft.name.trim(),
        role: draft.role.trim(),
        instructions: draft.instructions,
        avatar: { ...(draft.plant ? { plant: draft.plant } : {}), ...(draft.tint ? { tint: draft.tint } : {}) },
      },
      {
        onSuccess: async (agent) => {
          notify(t('agents.created', { name: agent.name }));
          // Straight into its thread; the drawer closes once there is somewhere to go.
          const conversation = await openConversation
            .mutateAsync({ kind: 'direct', agent_id: agent.id })
            .catch(() => null);
          dismiss.saved();
          if (conversation) navigate({ page: 'conversation', id: conversation.id });
        },
        onError: (caught) =>
          setError(
            caught instanceof ApiClientError
              ? caught.code === 'agent_name_taken'
                ? t('agents.nameTaken')
                : caught.code === 'agent_limit'
                  ? t('agents.limit')
                  : errorText(caught, t)
              : t('common.error'),
          ),
      },
    );
  };

  if (!draft) {
    return (
      <>
        <Overlay title={t('agents.new')} onClose={onClose} beforeClose={dismiss.beforeClose}>
          <h3 className="app-section-title">{t('agents.templates')}</h3>
          <ul className="app-template-list">
            {templates.map((template) => (
              <li key={template.key}>
                <button type="button" className="app-template" onClick={() => choose(template)}>
                  <AgentAvatar
                    agent={{ id: template.key, avatar: { plant: template.plant }, template_key: template.key }}
                    size={36}
                  />
                  <span className="app-template-text">
                    <strong>
                      {template.copy[locale].name} · {template.copy[locale].role}
                    </strong>
                    <span>{pitch(template)}</span>
                  </span>
                </button>
              </li>
            ))}
            <li>
              <button type="button" className="app-template" onClick={() => choose(null)}>
                <span className="app-template-blank" aria-hidden>
                  <Plus size={icon.lg} />
                </span>
                <span className="app-template-text">
                  <strong>{t('agents.blank')}</strong>
                  <span>{t('agents.blankPitch')}</span>
                </span>
              </button>
            </li>
          </ul>
        </Overlay>
        {dismiss.confirmation}
      </>
    );
  }

  return (
    <>
      <Overlay title={t('agents.new')} onClose={onClose} beforeClose={dismiss.beforeClose}>
        <form {...dismiss.formProps} id="new-agent" className="app-form" onSubmit={submit}>
          <FieldGroup label={t('agents.avatar')}>
            <PlantPicker
              agentId={draft.template_key ?? 'new'}
              plant={draft.plant}
              tint={draft.tint}
              onChange={(value) => setDraft({ ...draft, ...value })}
            />
          </FieldGroup>
          <Field label={t('agents.name')} required error={error || undefined}>
            <Input
              value={draft.name}
              maxLength={AGENT_NAME_MAX}
              autoFocus
              onChange={(event) => {
                setDraft({ ...draft, name: event.target.value });
                setError('');
              }}
            />
          </Field>
          <Field label={t('agents.role')}>
            <Input
              value={draft.role}
              maxLength={AGENT_ROLE_MAX}
              onChange={(event) => setDraft({ ...draft, role: event.target.value })}
            />
          </Field>
          <Field label={t('agents.instructions')} description={t('agents.instructionsHint')}>
            <TextArea
              value={draft.instructions}
              maxLength={AGENT_INSTRUCTIONS_MAX}
              maxRows={14}
              onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
            />
          </Field>
        </form>
        <OverlayActions>
          {!prefill && (
            <Button kind="ghost" className="app-actions-start" onClick={() => setDraft(null)}>
              {t('agents.back')}
            </Button>
          )}
          <Button onClick={dismiss.close}>{t('common.cancel')}</Button>
          <Button kind="primary" type="submit" form="new-agent" loading={create.isPending}>
            {t('agents.create')}
          </Button>
        </OverlayActions>
      </Overlay>
      {dismiss.confirmation}
    </>
  );
}
