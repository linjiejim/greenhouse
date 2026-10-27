/**
 * The custom agent editor (wide browser): a fixed-size dialog that creates, edits or duplicates
 * one of my agents (run profiles) — its look, name, instructions, model, tools, connectors and
 * governance notes. Rules and bodies are React-free (./agents.ts); the station checks the tools
 * against what I hold and the connectors against what I can use (apps/api/src/routes/profiles.ts),
 * and its words show inline when it refuses.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { listMyConnectors } from '../api/connectors';
import { createCustomAgent, listMyTools, listProfileCatalog, updateCustomAgent, type ChatModel } from '../api/profiles';
import { captureIdentity } from '../data/identity';
import { useT, type TranslationKey } from '../lib/i18n';
import { PlantAvatar } from '../ui/plant-avatar';
import { avatarTint, legacyToPlant, PLANT_IDS, PLANT_TINTS, withPlant, withTint } from '../ui/plant-avatar/plant-ids';
import { toast } from '../ui/toast';
import {
  AGENT_PROMPT_MAX,
  agentBody,
  agentDraftChanged,
  agentDraftFrom,
  agentRowId,
  duplicateAgentDraft,
  newAgentDraft,
  RISK_LEVELS,
  toolPicker,
  validateAgentDraft,
  type AgentDraft,
  type AgentDraftErrors,
  type CustomAgent,
  type RiskLevel,
  type ToolMeta,
} from './agents';
import { Check, EditorDialog, Field, focusFirstInvalid, useTouched } from './form-parts.web';

export type AgentEditorMode =
  | { kind: 'new' }
  | { kind: 'edit'; agent: CustomAgent }
  | { kind: 'duplicate'; agent: CustomAgent; name: string };

interface ConnectorOption {
  id: string;
  name: string;
  handle: string;
}

export function AgentEditor({
  mode,
  mine,
  onClose,
  onSaved,
}: {
  mode: AgentEditorMode;
  /** My agents (the slug check; an edited one is left out of it). */
  mine: readonly CustomAgent[];
  onClose: () => void;
  onSaved: (agent: CustomAgent) => void;
}) {
  const t = useT();
  const original = mode.kind === 'edit' ? mode.agent : null;
  const [models, setModels] = useState<ChatModel[] | null>(null);
  const [tools, setTools] = useState<ToolMeta[] | null>(null);
  const [connectors, setConnectors] = useState<ConnectorOption[] | null>(null);
  const [start, setStart] = useState<AgentDraft | null>(() =>
    mode.kind === 'edit' ? agentDraftFrom(mode.agent, 'flash') : null,
  );
  const [draft, setDraft] = useState<AgentDraft | null>(start);

  useEffect(() => {
    const current = captureIdentity();
    let alive = true;
    void (async () => {
      const [catalog, held, links] = await Promise.all([listProfileCatalog(), listMyTools(), listMyConnectors()]);
      if (!alive || !current()) return;
      const offered = catalog.ok ? catalog.data.models : [];
      const heldTools = held.ok ? held.data : [];
      const usable = links.ok ? [...links.data.team, ...links.data.personal] : null;
      setModels(offered);
      setTools(heldTools);
      setConnectors(usable ? usable.map((c) => ({ id: c.id, name: c.name, handle: c.handle })) : []);
      const fallback = offered[0]?.id ?? 'flash';
      // a new or duplicated agent starts once the models and tools it may use are known
      if (mode.kind !== 'edit') {
        const first =
          mode.kind === 'duplicate'
            ? duplicateAgentDraft(mode.agent, {
                name: mode.name,
                fallbackModel: fallback,
                heldTools: heldTools.map((tool) => tool.id),
                usableConnectors: usable ? usable.map((c) => c.id) : null,
              })
            : newAgentDraft(fallback);
        setStart(first);
        setDraft(first);
      }
    })();
    return () => {
      alive = false;
    };
    // the mode is fixed for the dialog's life
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [submitted, setSubmitted] = useState(false);
  const [touched, touch] = useTouched();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [toolQuery, setToolQuery] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const others = useMemo(() => mine.filter((agent) => agent.id !== original?.id), [mine, original]);
  const errors: AgentDraftErrors = draft ? validateAgentDraft(draft, others) : {};
  const shown = (field: keyof AgentDraftErrors) =>
    errors[field] && (submitted || touched.has(field))
      ? t(`agents.editor.error.${errors[field]}` as TranslationKey)
      : null;
  const dirty = !!draft && !!start && agentDraftChanged(draft, start);
  const set = (patch: Partial<AgentDraft>) => {
    setSaveError('');
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };
  const leave = (field: 'name' | 'prompt' | 'maxSteps') =>
    touch(field, !!draft && !!start && draft[field] !== start[field]);

  const save = async () => {
    if (saving || !draft) return;
    setSubmitted(true);
    if (Object.keys(errors).length) {
      requestAnimationFrame(() => focusFirstInvalid());
      return;
    }
    const body = agentBody(draft, original ? start : null);
    if (original && !Object.keys(body).length) {
      onClose();
      return;
    }
    const current = captureIdentity();
    setSaving(true);
    const r = original ? await updateCustomAgent(agentRowId(original.id), body) : await createCustomAgent(body);
    if (!alive.current || !current()) return;
    setSaving(false);
    if (!r.ok) {
      setSaveError(r.message || t('agents.saveFailed'));
      return;
    }
    toast(original ? t('agents.saved') : t('agents.created'));
    onSaved(r.data);
  };

  const title = t(
    mode.kind === 'edit'
      ? 'agents.editor.editTitle'
      : mode.kind === 'duplicate'
        ? 'agents.editor.duplicateTitle'
        : 'agents.editor.newTitle',
  );
  const lead = saveError ? (
    <span role="alert" className="gh-error" title={saveError}>
      {saveError}
    </span>
  ) : submitted && Object.keys(errors).length ? (
    <span role="alert" className="gh-error">
      {t('automations.editor.fixErrors')}
    </span>
  ) : (
    <span>{t('automations.editor.shortcut')}</span>
  );

  return (
    <EditorDialog
      title={title}
      testID="agent-editor"
      dirty={dirty}
      busy={saving || !draft}
      saveLabel={t(original ? 'agents.editor.save' : 'agents.editor.create')}
      onClose={onClose}
      onSave={() => void save()}
      lead={lead}
      focus={nameRef}
    >
      {!draft ? (
        <p className="gh-hint" role="status">
          {t('common.loading')}
        </p>
      ) : (
        <>
          <Identity
            draft={draft}
            stableId={original?.id ?? 'new'}
            nameRef={nameRef}
            nameError={shown('name')}
            onChange={set}
            onBlurName={() => leave('name')}
          />
          <Field
            label={t('agents.editor.prompt')}
            count={t('automations.editor.count', { n: draft.prompt.trim().length, max: AGENT_PROMPT_MAX })}
            over={draft.prompt.trim().length > AGENT_PROMPT_MAX}
            error={shown('prompt')}
          >
            {({ id, describedBy, invalid }) => (
              <textarea
                id={id}
                className="gh-input"
                rows={9}
                value={draft.prompt}
                placeholder={t('agents.editor.promptPlaceholder')}
                aria-invalid={invalid}
                aria-describedby={describedBy}
                onChange={(e) => set({ prompt: e.target.value })}
                onBlur={() => leave('prompt')}
              />
            )}
          </Field>
          <div className="gh-form-grid">
            <Field label={t('agents.editor.model')} hint={t('agents.editor.modelHint')}>
              {({ id, describedBy }) => (
                <select
                  id={id}
                  className="gh-input"
                  value={draft.modelId}
                  aria-describedby={describedBy}
                  onChange={(e) => set({ modelId: e.target.value })}
                >
                  {/* an agent pinned to a model the station no longer offers keeps showing it */}
                  {!(models ?? []).some((model) => model.id === draft.modelId) ? (
                    <option value={draft.modelId}>{draft.modelId}</option>
                  ) : null}
                  {(models ?? []).map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label={t('agents.editor.maxSteps')} hint={t('agents.editor.maxStepsHint')} error={shown('maxSteps')}>
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  className="gh-input"
                  type="number"
                  min={1}
                  max={50}
                  inputMode="numeric"
                  value={draft.maxSteps}
                  aria-invalid={invalid}
                  aria-describedby={describedBy}
                  onChange={(e) => set({ maxSteps: e.target.value })}
                  onBlur={() => leave('maxSteps')}
                />
              )}
            </Field>
          </div>
          <ToolPicker
            tools={tools}
            selected={draft.tools}
            query={toolQuery}
            onQuery={setToolQuery}
            onChange={(next) => set({ tools: next })}
          />
          <Connectors options={connectors} value={draft.connectors} onChange={(next) => set({ connectors: next })} />
          <fieldset className="gh-form-section">
            <legend>{t('agents.editor.governance')}</legend>
            <div className="gh-form-grid">
              <Field label={t('agents.editor.purpose')}>
                {({ id }) => (
                  <input
                    id={id}
                    className="gh-input"
                    value={draft.purpose}
                    placeholder={t('agents.editor.purposePlaceholder')}
                    onChange={(e) => set({ purpose: e.target.value })}
                  />
                )}
              </Field>
              <Field label={t('agents.editor.audience')}>
                {({ id }) => (
                  <input
                    id={id}
                    className="gh-input"
                    value={draft.audience}
                    placeholder={t('agents.editor.audiencePlaceholder')}
                    onChange={(e) => set({ audience: e.target.value })}
                  />
                )}
              </Field>
            </div>
            <div className="gh-form-grid">
              <Field label={t('agents.editor.risk')}>
                {({ id }) => (
                  <select
                    id={id}
                    className="gh-input"
                    value={draft.riskLevel}
                    onChange={(e) => set({ riskLevel: e.target.value as RiskLevel })}
                  >
                    {RISK_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {t(`agents.riskLevel.${level}`)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
          </fieldset>
          {original ? (
            <p className="gh-callout" data-tone="neutral">
              {t('agents.editor.versionNote', { n: (original.current_version ?? 1) + 1 })}
              {original.is_shared ? ` ${t('agents.editor.sharedNote')}` : ''}
            </p>
          ) : null}
        </>
      )}
    </EditorDialog>
  );
}

function Identity({
  draft,
  stableId,
  nameRef,
  nameError,
  onChange,
  onBlurName,
}: {
  draft: AgentDraft;
  stableId: string;
  nameRef: React.RefObject<HTMLInputElement | null>;
  nameError: string | null;
  onChange: (patch: Partial<AgentDraft>) => void;
  onBlurName: () => void;
}) {
  const t = useT();
  const plant = legacyToPlant(draft.avatar, null, stableId);
  const tint = avatarTint(draft.avatar);
  return (
    <>
      <div className="gh-auto-identity">
        <PlantAvatar plant={plant} tint={tint} size={64} animate={false} seed={stableId} />
        <div className="gh-form-section">
          <Field label={t('agents.editor.name')} error={nameError}>
            {({ id, describedBy, invalid }) => (
              <input
                ref={nameRef}
                id={id}
                className="gh-input"
                value={draft.name}
                maxLength={80}
                placeholder={t('agents.editor.namePlaceholder')}
                aria-invalid={invalid}
                aria-describedby={describedBy}
                onChange={(e) => onChange({ name: e.target.value })}
                onBlur={onBlurName}
              />
            )}
          </Field>
          <Field label={t('agents.editor.description')}>
            {({ id }) => (
              <input
                id={id}
                className="gh-input"
                value={draft.description}
                placeholder={t('agents.editor.descriptionPlaceholder')}
                onChange={(e) => onChange({ description: e.target.value })}
              />
            )}
          </Field>
        </div>
      </div>
      <div className="gh-form-section" role="group" aria-label={t('agents.editor.look')}>
        <Swatches
          label={t('agents.editor.plant')}
          // the sprout is Sprouty's face; offered only to an agent that already wears it
          items={PLANT_IDS.filter((id) => id !== 'sprout' || plant === 'sprout').map((id) => ({
            id,
            name: t(`agents.plant.${id}`),
            node: <PlantAvatar plant={id} tint={tint} size={28} animate={false} />,
          }))}
          value={plant}
          onChange={(id) => onChange({ avatar: withPlant(draft.avatar, id as (typeof PLANT_IDS)[number]) })}
        />
        <Swatches
          label={t('agents.editor.tint')}
          items={PLANT_TINTS.map((id) => ({
            id,
            name: t(`agents.tint.${id}`),
            node: <PlantAvatar plant={plant} tint={id} size={22} animate={false} />,
          }))}
          value={tint}
          // a tint is written together with the plant shown, so a legacy avatar keeps its look
          onChange={(id) =>
            onChange({ avatar: withTint(withPlant(draft.avatar, plant), id as (typeof PLANT_TINTS)[number]) })
          }
        />
      </div>
    </>
  );
}

/** A radio group of round swatches; arrow keys move the choice. */
function Swatches({
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  items: { id: string; name: string; node: React.ReactNode }[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="gh-field">
      <span className="gh-field-label">{label}</span>
      <div
        className="gh-auto-swatches"
        role="radiogroup"
        aria-label={label}
        onKeyDown={(e) => {
          if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
          e.preventDefault();
          const group = e.currentTarget;
          const i = items.findIndex((item) => item.id === value);
          const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
          const next = items[(i + step + items.length) % items.length]!;
          onChange(next.id);
          requestAnimationFrame(() => group.querySelector<HTMLElement>(`[data-swatch="${next.id}"]`)?.focus());
        }}
      >
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            data-swatch={item.id}
            aria-checked={item.id === value}
            aria-label={item.name}
            title={item.name}
            tabIndex={item.id === value ? 0 : -1}
            onClick={() => onChange(item.id)}
          >
            {item.node}
          </button>
        ))}
      </div>
    </div>
  );
}

function ToolPicker({
  tools,
  selected,
  query,
  onQuery,
  onChange,
}: {
  tools: ToolMeta[] | null;
  selected: readonly string[];
  query: string;
  onQuery: (q: string) => void;
  onChange: (ids: string[]) => void;
}) {
  const t = useT();
  const picker = useMemo(() => toolPicker(tools ?? [], selected, query), [tools, selected, query]);
  const picked = new Set(selected);
  const toggle = (id: string, on: boolean) => onChange(on ? [...selected, id] : selected.filter((x) => x !== id));
  const groupName = (id: string) => {
    const key = `agents.editor.group.${id}` as TranslationKey;
    const known = t(key);
    return known === key ? id : known;
  };
  return (
    <fieldset className="gh-form-section">
      <legend>
        {t('agents.editor.tools')}
        <small>{t('agents.editor.toolsSelected', { n: selected.length })}</small>
      </legend>
      <p className="gh-hint">{t('agents.editor.toolsHint')}</p>
      <div className="gh-auto-tools" data-testid="agent-tools">
        <div className="gh-auto-tools-bar">
          <input
            className="gh-input"
            type="search"
            aria-label={t('agents.editor.filterTools')}
            placeholder={t('agents.editor.filterTools')}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
          />
          <button
            type="button"
            className="gh-link-button"
            onClick={() => onChange([...new Set([...selected, ...picker.pickable])])}
          >
            {t('agents.editor.selectAll')}
          </button>
          <button type="button" className="gh-link-button" onClick={() => onChange([])}>
            {t('agents.editor.clear')}
          </button>
        </div>
        <div className="gh-auto-tools-list">
          {tools === null ? (
            <p className="gh-hint gh-auto-tools-empty">{t('common.loading')}</p>
          ) : (
            <>
              {picker.groups.map((group) => (
                <div key={group.id} role="group" aria-label={groupName(group.id)}>
                  <h4>{groupName(group.id)}</h4>
                  {group.tools.map((tool) => {
                    const access = tool.surface?.proxy;
                    return (
                      <label key={tool.id} className="gh-auto-tool">
                        <input
                          type="checkbox"
                          checked={picked.has(tool.id)}
                          onChange={(e) => toggle(tool.id, e.target.checked)}
                        />
                        <span>
                          <b>
                            {tool.name}
                            {access === 'read' ? (
                              <span className="gh-badge" data-tone="info">
                                {t('agents.editor.read')}
                              </span>
                            ) : null}
                            {access === 'write' ? (
                              <span className="gh-badge" data-tone="warning">
                                {t('agents.editor.write')}
                              </span>
                            ) : null}
                          </b>
                          {tool.brief ? <small>{tool.brief}</small> : null}
                        </span>
                      </label>
                    );
                  })}
                </div>
              ))}
              {picker.missing.map((id) => (
                <label key={id} className="gh-auto-tool">
                  <input type="checkbox" checked onChange={() => toggle(id, false)} />
                  <span>
                    <b>
                      {id}
                      <span className="gh-badge" data-tone="danger">
                        {t('agents.editor.gone')}
                      </span>
                    </b>
                  </span>
                </label>
              ))}
              {!picker.groups.length && !picker.missing.length ? (
                <p className="gh-hint gh-auto-tools-empty">{t('agents.editor.noTools')}</p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </fieldset>
  );
}

/** Which connectors the agent may use through `mcp_call`: all of mine, or only the ones ticked. */
function Connectors({
  options,
  value,
  onChange,
}: {
  options: ConnectorOption[] | null;
  value: string[] | null;
  onChange: (next: string[] | null) => void;
}) {
  const t = useT();
  // nothing to narrow: no connectors (or no `mcp_call`), and none chosen before
  if (!options || (options.length === 0 && value === null)) return null;
  const known = new Set(options.map((option) => option.id));
  const chosen = value ?? [];
  return (
    <fieldset className="gh-form-section">
      <legend>{t('agents.editor.connectors')}</legend>
      <p className="gh-hint">{t('agents.editor.connectorsHint')}</p>
      <Check
        label={t('agents.editor.connectorsAll')}
        checked={value === null}
        onChange={(all) => onChange(all ? null : options.map((option) => option.id))}
      />
      {value !== null ? (
        <div className="gh-auto-checks" role="group" aria-label={t('agents.editor.connectorsOnly')}>
          {options.map((option) => (
            <Check
              key={option.id}
              label={option.name}
              hint={option.handle}
              checked={chosen.includes(option.id)}
              onChange={(on) => onChange(on ? [...chosen, option.id] : chosen.filter((id) => id !== option.id))}
            />
          ))}
        </div>
      ) : null}
      {chosen.some((id) => !known.has(id)) ? <p className="gh-hint">{t('agents.editor.connectorsGone')}</p> : null}
    </fieldset>
  );
}
