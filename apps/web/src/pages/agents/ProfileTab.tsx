import { errorText } from '../../lib/errors';
/**
 * 资料: plant, name, role, about and instructions. Saving appends a version (with an optional
 * note); the history below lists them. Instruction changes an Agent proposes itself arrive as
 * a proposal card instead (AGNT-06).
 */

import { useMemo, useState, type FormEvent } from 'react';
import { PLANT_IDS, PLANT_TINTS } from '@greenhouse/types';
import {
  AGENT_DESCRIPTION_MAX,
  AGENT_INSTRUCTIONS_MAX,
  AGENT_NAME_MAX,
  AGENT_ROLE_MAX,
  type AgentDetail,
} from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { Button, ConfirmDialog, Field, FieldGroup, Input, Skeleton, TextArea } from '@greenhouse/ui/kit';
import { useNotify } from '../../app/notify';
import { useMe } from '../../app/session';
import { useUpdateAgent, useVersions } from '../../data/agents';
import { cx } from '../../lib/cx';
import { useI18n } from '../../lib/i18n';
import { relativeTime } from '../../lib/time';
import { useDraftNavigation } from '../../lib/useDraftNavigation';
import { AgentAvatar } from '../../shell/AgentAvatar';

type Draft = { name: string; role: string; description: string; instructions: string; plant: string; tint: string };

const draftOf = (agent: AgentDetail): Draft => ({
  name: agent.name,
  role: agent.role,
  description: agent.description,
  instructions: agent.instructions,
  plant: agent.avatar.plant ?? '',
  tint: agent.avatar.tint ?? '',
});

export function PlantPicker({
  agentId,
  plant,
  tint,
  onChange,
}: {
  agentId: string;
  plant: string;
  tint: string;
  onChange: (value: { plant: string; tint: string }) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="app-plant-picker">
      <div className="app-plant-grid" role="radiogroup" aria-label={t('agents.avatar')}>
        {PLANT_IDS.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={plant === id}
            aria-label={id}
            className={cx('app-plant-option', plant === id && 'is-selected')}
            onClick={() => onChange({ plant: id, tint })}
          >
            <AgentAvatar
              agent={{ id: agentId, avatar: { plant: id, tint: tint || undefined }, template_key: null }}
              size={36}
            />
          </button>
        ))}
      </div>
      <div className="app-tint-row" role="radiogroup" aria-label={t('agents.tint')}>
        {PLANT_TINTS.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={(tint || 'plant') === id}
            aria-label={id}
            className={cx('app-tint-option', `is-${id}`, (tint || 'plant') === id && 'is-selected')}
            onClick={() => onChange({ plant, tint: id === 'plant' ? '' : id })}
          />
        ))}
      </div>
    </div>
  );
}

export function ProfileTab({ agent }: { agent: AgentDetail }) {
  const { t, locale } = useI18n();
  const me = useMe();
  const notify = useNotify();
  const update = useUpdateAgent(agent.id);
  const versions = useVersions(agent.id);
  const [draft, setDraft] = useState<Draft>(() => draftOf(agent));
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const original = useMemo(() => draftOf(agent), [agent]);
  const dirty = (Object.keys(draft) as (keyof Draft)[]).some((key) => draft[key] !== original[key]);
  const readOnly = !!agent.archived_at;
  const discard = () => {
    setDraft(original);
    setNote('');
    setError('');
  };
  const navigation = useDraftNavigation(dirty, update.isPending, discard);

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.name.trim()) return setError(t('request.required', { name: t('agents.name') }));
    update.mutate(
      {
        name: draft.name.trim(),
        role: draft.role.trim(),
        description: draft.description.trim(),
        instructions: draft.instructions,
        avatar: { ...(draft.plant ? { plant: draft.plant } : {}), ...(draft.tint ? { tint: draft.tint } : {}) },
        ...(note.trim() ? { change_note: note.trim() } : {}),
      },
      {
        onSuccess: (saved) => {
          navigation.saved();
          setDraft(draftOf(saved));
          setNote('');
          setError('');
          notify(t('agents.saved', { version: saved.current_version }));
        },
        onError: (caught) =>
          setError(
            caught instanceof ApiClientError && caught.code === 'agent_name_taken'
              ? t('agents.nameTaken')
              : errorText(caught, t),
          ),
      },
    );
  };

  return (
    <>
      <form
        className="app-form"
        onSubmit={save}
        aria-label={t('agents.tabProfile')}
        aria-busy={update.isPending}
        inert={update.isPending}
      >
        <FieldGroup label={t('agents.avatar')}>
          <PlantPicker
            agentId={agent.id}
            plant={draft.plant}
            tint={draft.tint}
            onChange={(value) => setDraft({ ...draft, ...value })}
          />
        </FieldGroup>
        <Field label={t('agents.name')} required error={error || undefined}>
          <Input
            value={draft.name}
            maxLength={AGENT_NAME_MAX}
            disabled={readOnly}
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
            disabled={readOnly}
            onChange={(event) => setDraft({ ...draft, role: event.target.value })}
          />
        </Field>
        <Field label={t('agents.description')}>
          <TextArea
            value={draft.description}
            maxLength={AGENT_DESCRIPTION_MAX}
            maxRows={4}
            disabled={readOnly}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          />
        </Field>
        <Field label={t('agents.instructions')} description={t('agents.instructionsHint')}>
          <TextArea
            value={draft.instructions}
            maxLength={AGENT_INSTRUCTIONS_MAX}
            maxRows={16}
            disabled={readOnly}
            onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
          />
        </Field>
        {dirty && (
          <div className="app-save-bar" role="status">
            <span className="app-save-bar-text">{t('agents.unsaved')}</span>
            <Input
              className="app-save-note"
              placeholder={t('agents.changeNote')}
              aria-label={t('agents.changeNote')}
              value={note}
              maxLength={200}
              onChange={(event) => setNote(event.target.value)}
            />
            <Button onClick={discard}>{t('agents.discard')}</Button>
            <Button kind="primary" type="submit" loading={update.isPending}>
              {t('agents.saveVersion')}
            </Button>
          </div>
        )}
      </form>

      <section className="app-section" aria-label={t('agents.versions')}>
        <h2 className="app-section-title">{t('agents.versions')}</h2>
        {versions.isPending ? (
          <Skeleton lines={3} />
        ) : (
          <ol className="app-list">
            {(versions.data?.items ?? []).map((version) => (
              <li key={version.version} className="app-list-row is-static">
                <span className="app-list-main">
                  <span className="app-list-title">{t('agents.version', { version: version.version })}</span>
                  {version.change_note && <span className="app-list-meta">{version.change_note}</span>}
                </span>
                <time className="app-list-time" dateTime={version.created_at}>
                  {relativeTime(version.created_at, { locale, timeZone: me.timezone })}
                </time>
              </li>
            ))}
          </ol>
        )}
      </section>
      {navigation.asking && (
        <ConfirmDialog
          title={t('knowledge.discardTitle')}
          cancelLabel={t('knowledge.keepEditing')}
          confirmLabel={t('knowledge.discard')}
          onCancel={navigation.cancel}
          onConfirm={navigation.discard}
        >
          {t('knowledge.discardBody')}
        </ConfirmDialog>
      )}
    </>
  );
}
