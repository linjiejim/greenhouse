/**
 * ProfileEditorDrawer — Centered dialog for creating/editing custom Agent profiles.
 * (Name kept for backward compatibility with existing imports.)
 *
 * Features:
 * - Tools grouped by category (Core / Team / Admin)
 * - Auto-generated slug display (read-only)
 * - System prompt character counter (xxx / 8000)
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Button, Checkbox, ConfirmDialog, Dialog, Input, Select, Spinner, Tag, Textarea } from '../ui';
import { X, ChevronDown, ChevronUp, Maximize2 } from '../../lib/icons';
import { getToolIcon, getToolBrief } from '../../lib/icons';
import { SproutyAvatar, COLOR_PRESETS, ACCESSORIES, EYE_STYLES, LEAF_STYLES } from '../sprouty/index.js';
import type { Profile, ToolMeta, CustomProfileInput } from '../../lib/api';
import type { EyeStyle, LeafStyle } from '../sprouty/index.js';
import { useT, type TranslationKey } from '../../lib/i18n';
import { FormActions, FormError, FormField, FormGrid } from '../form';
import { useProfileStore } from '../../stores';

const MAX_PROMPT_CHARS = 8000;

// ─── Slugify (mirrors backend) ──────────────────────────

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/[^a-z0-9\u4e00-\u9fff-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50) || 'profile'
  );
}

// ─── Types ──────────────────────────────────────────────

interface ProfileFormData {
  name: string;
  description: string;
  base_profile_id: string;
  model_id: string;
  tools: string[];
  system_prompt: string;
  max_steps: number;
  purpose: string;
  audience: string;
  risk_level: 'low' | 'medium' | 'high';
  change_log: string;
  avatar_color: string;
  avatar_accessories: string[];
  avatar_leafStyle: LeafStyle;
  avatar_eyeStyle: EyeStyle;
}

interface ProfileEditorDrawerProps {
  open: boolean;
  onClose: () => void;
  profile: Profile | null; // null = create mode
  availableTools: ToolMeta[];
  isSuper: boolean;
  onSave: (input: CustomProfileInput, editId?: number) => Promise<void>;
}

function createEmptyForm(): ProfileFormData {
  return {
    name: '',
    description: '',
    base_profile_id: 'sprouty',
    model_id: 'flash',
    tools: [],
    system_prompt: '',
    max_steps: 12,
    purpose: '',
    audience: '',
    risk_level: 'medium',
    change_log: '',
    avatar_color: 'forest',
    avatar_accessories: [],
    avatar_leafStyle: 'normal',
    avatar_eyeStyle: 'classic',
  };
}

function createProfileForm(profile: Profile): ProfileFormData {
  return {
    name: profile.name,
    description: profile.description || '',
    base_profile_id: profile.base_profile_id || 'sprouty',
    model_id: profile.model_id || 'flash',
    tools: profile.tools || [],
    system_prompt: profile.system_prompt || '',
    max_steps: profile.max_steps || 12,
    purpose: profile.purpose || '',
    audience: profile.audience || '',
    risk_level: profile.risk_level || 'medium',
    change_log: '',
    avatar_color: profile.avatar?.color || 'forest',
    avatar_accessories: profile.avatar?.accessories || [],
    avatar_leafStyle: profile.avatar?.leafStyle || 'normal',
    avatar_eyeStyle: profile.avatar?.eyeStyle || 'classic',
  };
}

// ─── Component ──────────────────────────────────────────

export function ProfileEditorDrawer({
  open,
  onClose,
  profile,
  availableTools,
  isSuper,
  onSave,
}: ProfileEditorDrawerProps) {
  const t = useT();
  const isEditing = !!profile;
  // Same list as the Chat picker: catalog models this deployment can reach.
  const { models, fetchProfiles } = useProfileStore();
  useEffect(() => {
    if (open) void fetchProfiles();
  }, [open, fetchProfiles]);

  const [form, setForm] = useState<ProfileFormData>(createEmptyForm);
  // An Agent pinned to a model the catalog no longer offers (retired, or its
  // key unset) already runs on the default; show and save that, not an id the
  // server would reject. Before the list loads, keep the stored value.
  const offeredModelId =
    models.length === 0 || models.some((m) => m.id === form.model_id) ? form.model_id : (models[0]?.id ?? 'flash');
  const [initialForm, setInitialForm] = useState<ProfileFormData>(createEmptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [toolSearch, setToolSearch] = useState('');
  const [selectedToolsOnly, setSelectedToolsOnly] = useState(false);
  const [showAppearance, setShowAppearance] = useState(false);
  const [previewState, setPreviewState] = useState<'idle' | 'thinking' | 'responding' | 'done' | 'error'>('idle');
  const [promptFullscreen, setPromptFullscreen] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [touched, setTouched] = useState({ name: false, systemPrompt: false });

  // Reset form when profile changes
  useEffect(() => {
    if (open) {
      const nextForm = profile
        ? createProfileForm(profile)
        : { ...createEmptyForm(), change_log: t('profileEditor.initialVersion') };
      setForm(nextForm);
      setInitialForm(nextForm);
      setError('');
      setToolSearch('');
      setSelectedToolsOnly(false);
      setShowAppearance(false);
      setPromptFullscreen(false);
      setDiscardConfirmOpen(false);
      setTouched({ name: false, systemPrompt: false });
    }
  }, [open, profile, t]);

  /**
   * Tools the author actually chooses between. Built-ins are excluded: every
   * Agent gets them regardless, so offering them as checkboxes would be asking
   * a question whose answer does not matter.
   */
  const pickableTools = useMemo(() => availableTools.filter((t) => !t.builtin), [availableTools]);

  // Group tools by category
  const toolGroups = useMemo(() => {
    const groups: Record<string, ToolMeta[]> = { core: [], team: [], admin: [] };
    const search = toolSearch.toLowerCase();
    for (const t of pickableTools) {
      if (selectedToolsOnly && !form.tools.includes(t.id)) continue;
      if (
        search &&
        !t.name.toLowerCase().includes(search) &&
        !t.id.toLowerCase().includes(search) &&
        !t.brief.toLowerCase().includes(search)
      ) {
        continue;
      }
      const cat = t.category || 'core';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(t);
    }
    return groups;
  }, [pickableTools, form.tools, selectedToolsOnly, toolSearch]);

  const slug = useMemo(() => slugify(form.name), [form.name]);
  const promptLength = form.system_prompt.length;
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initialForm), [form, initialForm]);
  const nameMissing = !form.name.trim();
  const promptMissing = !form.system_prompt.trim();
  const canSave = !nameMissing && !promptMissing && promptLength <= MAX_PROMPT_CHARS;
  const appearanceSummary = t('profileEditor.appearanceSummary', {
    color: t(`profileEditor.colorName.${form.avatar_color}` as TranslationKey),
    leaf: t(`profileEditor.leafName.${form.avatar_leafStyle}` as TranslationKey),
    eyes: t(`profileEditor.eyeName.${form.avatar_eyeStyle}` as TranslationKey),
    count: form.avatar_accessories.length,
  });

  const requestClose = () => {
    if (dirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    onClose();
  };

  const toggleTool = (toolId: string) => {
    setForm((prev) => ({
      ...prev,
      tools: prev.tools.includes(toolId) ? prev.tools.filter((t) => t !== toolId) : [...prev.tools, toolId],
    }));
  };

  const selectAllTools = () => {
    setForm((prev) => ({ ...prev, tools: pickableTools.map((t) => t.id) }));
  };

  const clearAllTools = () => {
    setForm((prev) => ({ ...prev, tools: [] }));
  };

  const handleSave = async () => {
    setTouched({ name: true, systemPrompt: true });
    if (!form.name.trim()) {
      setError(t('profileEditor.nameRequired'));
      return;
    }
    if (!form.system_prompt.trim()) {
      setError(t('profileEditor.systemPromptRequired'));
      return;
    }
    if (promptLength > MAX_PROMPT_CHARS) {
      setError(t('profileEditor.systemPromptTooLong', { count: MAX_PROMPT_CHARS }));
      return;
    }

    setSaving(true);
    setError('');
    try {
      const input: CustomProfileInput = {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        base_profile_id: form.base_profile_id,
        model_id: offeredModelId,
        tools: form.tools,
        system_prompt: form.system_prompt.trim(),
        max_steps: form.max_steps,
        purpose: form.purpose.trim() || undefined,
        audience: form.audience.trim() || undefined,
        risk_level: form.risk_level,
        change_log: form.change_log.trim() || undefined,
        avatar: {
          color: form.avatar_color,
          accessories: form.avatar_accessories,
          leafStyle: form.avatar_leafStyle,
          eyeStyle: form.avatar_eyeStyle,
        },
      };

      const editId = profile ? parseInt(profile.id.replace('custom:', ''), 10) : undefined;
      await onSave(input, editId);
      onClose();
    } catch (err: any) {
      setError(err.message || t('common.saveFailed'));
    }
    setSaving(false);
  };

  const groupLabels: Record<string, TranslationKey> = {
    core: 'profileEditor.groupCore',
    team: 'profileEditor.groupTeam',
    admin: 'profileEditor.groupAdmin',
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={requestClose}
        title={t(isEditing ? 'profileEditor.editAgent' : 'profileEditor.createAgent')}
        size="wide"
        noPadding
        scrollBody={false}
      >
        {/* Fullscreen Prompt Editor Overlay */}
        {promptFullscreen && (
          <div className="absolute inset-0 z-10 bg-surface-raised flex flex-col rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 border-b border-edge flex-shrink-0">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-fg-secondary">{t('profileEditor.systemPrompt')}</h3>
                <span
                  className={`text-[10px] font-mono ${
                    promptLength > MAX_PROMPT_CHARS ? 'text-danger font-semibold' : 'text-fg-faint'
                  }`}
                >
                  {promptLength.toLocaleString()} / {MAX_PROMPT_CHARS.toLocaleString()}
                </span>
              </div>
              <button
                onClick={() => setPromptFullscreen(false)}
                className="p-1.5 rounded-md hover:bg-surface-muted text-fg-faint hover:text-fg-secondary transition-colors"
                title={t('profileEditor.exitFullscreen')}
              >
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 p-4">
              <Textarea
                value={form.system_prompt}
                onChange={(e) => setForm({ ...form, system_prompt: e.target.value })}
                placeholder={t('profileEditor.systemPromptPlaceholder')}
                className="h-full bg-surface-sunken px-4 py-3 font-mono leading-relaxed"
              />
            </div>
          </div>
        )}
        {/* Body */}
        <div className="flex min-h-0 flex-1 flex-col">
          {error && (
            <div className="mx-4 mt-3 flex-shrink-0 sm:mx-6">
              <FormError>{error}</FormError>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[minmax(0,1.15fr)_minmax(20rem,0.85fr)] lg:overflow-hidden">
            <div className="min-h-0 space-y-5 px-4 py-4 sm:px-6 lg:overflow-y-auto lg:overscroll-contain lg:[scrollbar-gutter:stable]">
              {/* Appearance stays compact until the user chooses to personalize it. */}
              <section className="overflow-hidden rounded-xl border border-edge bg-surface-sunken">
                <button
                  type="button"
                  onClick={() => setShowAppearance((visible) => !visible)}
                  aria-expanded={showAppearance}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface-muted"
                >
                  <SproutyAvatar
                    variant="custom"
                    color={form.avatar_color}
                    accessories={form.avatar_accessories}
                    leafStyle={form.avatar_leafStyle}
                    eyeStyle={form.avatar_eyeStyle}
                    state="idle"
                    size="sm"
                    animate={false}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium text-fg-secondary">{t('profileEditor.appearance')}</span>
                    <span className="block truncate text-[10px] text-fg-faint">{appearanceSummary}</span>
                  </span>
                  {showAppearance ? (
                    <ChevronUp size={14} className="text-fg-faint" />
                  ) : (
                    <ChevronDown size={14} className="text-fg-faint" />
                  )}
                </button>

                {showAppearance && (
                  <div className="grid gap-4 border-t border-edge p-4 sm:grid-cols-[7rem_minmax(0,1fr)]">
                    <div className="flex flex-col items-center gap-2">
                      <SproutyAvatar
                        variant="custom"
                        color={form.avatar_color}
                        accessories={form.avatar_accessories}
                        leafStyle={form.avatar_leafStyle}
                        eyeStyle={form.avatar_eyeStyle}
                        state={previewState}
                        size="xl"
                        animate
                      />
                      <div className="flex max-w-[7rem] flex-wrap justify-center gap-0.5">
                        {(['idle', 'thinking', 'responding', 'done', 'error'] as const).map((state) => (
                          <button
                            key={state}
                            type="button"
                            onClick={() => setPreviewState(state)}
                            className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium transition-colors ${
                              previewState === state
                                ? 'bg-primary-subtle text-primary-fg-strong'
                                : 'text-fg-faint hover:bg-surface-muted hover:text-fg-muted'
                            }`}
                          >
                            {t(`profileEditor.previewState.${state}` as TranslationKey)}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="min-w-0 space-y-3">
                      <div>
                        <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-fg-faint">
                          {t('profileEditor.color')}
                        </label>
                        <div className="flex flex-wrap items-center gap-2">
                          {Object.entries(COLOR_PRESETS).map(([key, colors]) => (
                            <button
                              key={key}
                              type="button"
                              onClick={() => setForm({ ...form, avatar_color: key })}
                              title={t(`profileEditor.colorName.${key}` as TranslationKey)}
                              className={`h-6 w-6 rounded-full border-2 transition-all ${
                                form.avatar_color === key
                                  ? 'scale-110 border-fg-secondary ring-2 ring-primary-300/40'
                                  : 'border-transparent hover:scale-105 hover:border-edge-strong'
                              }`}
                              style={{ backgroundColor: colors.body }}
                            />
                          ))}
                        </div>
                      </div>

                      <div>
                        <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-fg-faint">
                          {t('profileEditor.accessories')}
                        </label>
                        <div className="grid gap-2 sm:grid-cols-3">
                          {(['hat', 'glasses', 'held'] as const).map((type) => {
                            const items = ACCESSORIES.filter((accessory) => accessory.type === type);
                            const typeLabel = t(`profileEditor.accessoryType.${type}` as TranslationKey);
                            return (
                              <div key={type}>
                                <span className="mb-1 block text-[9px] text-fg-faint">{typeLabel}</span>
                                <div className="flex flex-wrap items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setForm({
                                        ...form,
                                        avatar_accessories: form.avatar_accessories.filter(
                                          (accessory) => !items.some((item) => item.id === accessory),
                                        ),
                                      })
                                    }
                                    className={`flex h-7 w-7 items-center justify-center rounded-md text-[10px] transition-colors ${
                                      !items.some((item) => form.avatar_accessories.includes(item.id))
                                        ? 'bg-primary-subtle text-primary-fg-strong ring-1 ring-primary-edge'
                                        : 'text-fg-faint hover:bg-surface-muted'
                                    }`}
                                    title={t('profileEditor.none')}
                                  >
                                    ✕
                                  </button>
                                  {items.map((accessory) => {
                                    const selected = form.avatar_accessories.includes(accessory.id);
                                    return (
                                      <button
                                        key={accessory.id}
                                        type="button"
                                        onClick={() => {
                                          const others = form.avatar_accessories.filter(
                                            (value) => !items.some((item) => item.id === value),
                                          );
                                          setForm({
                                            ...form,
                                            avatar_accessories: selected ? others : [...others, accessory.id],
                                          });
                                        }}
                                        title={t(`profileEditor.accessoryName.${accessory.id}` as TranslationKey)}
                                        className={`flex h-7 w-7 items-center justify-center rounded-md text-sm transition-colors ${
                                          selected
                                            ? 'bg-primary-subtle ring-1 ring-primary-edge'
                                            : 'hover:bg-surface-muted'
                                        }`}
                                      >
                                        {accessory.emoji}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      <div>
                        <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-fg-faint">
                          {t('profileEditor.leafStyle')}
                        </label>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {LEAF_STYLES.map((style) => (
                            <button
                              key={style.id}
                              type="button"
                              onClick={() => setForm({ ...form, avatar_leafStyle: style.id })}
                              title={t(`profileEditor.leafName.${style.id}` as TranslationKey)}
                              className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${
                                form.avatar_leafStyle === style.id
                                  ? 'bg-primary-subtle text-primary-fg-strong ring-1 ring-primary-edge'
                                  : 'text-fg-faint hover:bg-surface-muted'
                              }`}
                            >
                              <span>{style.emoji}</span>
                              <span className="text-[10px]">
                                {t(`profileEditor.leafName.${style.id}` as TranslationKey)}
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>

                      <div>
                        <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-fg-faint">
                          {t('profileEditor.eyeStyle')}
                        </label>
                        <div className="grid grid-cols-2 gap-1.5">
                          {EYE_STYLES.map((style) => (
                            <button
                              key={style.id}
                              type="button"
                              onClick={() => setForm({ ...form, avatar_eyeStyle: style.id })}
                              title={t(`profileEditor.eyeDescription.${style.id}` as TranslationKey)}
                              className={`flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors ${
                                form.avatar_eyeStyle === style.id
                                  ? 'bg-primary-subtle text-primary-fg-strong ring-1 ring-primary-edge'
                                  : 'text-fg-faint hover:bg-surface-muted'
                              }`}
                            >
                              <SproutyAvatar
                                variant="custom"
                                color={form.avatar_color}
                                leafStyle={form.avatar_leafStyle}
                                eyeStyle={style.id}
                                state="idle"
                                size="sm"
                                animate={false}
                              />
                              <span className="min-w-0">
                                <span className="block truncate text-[10px] font-medium">
                                  {t(`profileEditor.eyeName.${style.id}` as TranslationKey)}
                                </span>
                                <span className="block truncate text-[9px] text-fg-faint">
                                  {t(`profileEditor.eyeDescription.${style.id}` as TranslationKey)}
                                </span>
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </section>

              {/* Name + Slug */}
              <FormField
                label={t('common.name')}
                required
                error={touched.name && nameMissing ? t('profileEditor.nameRequired') : undefined}
              >
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  onBlur={() => setTouched((current) => ({ ...current, name: true }))}
                  placeholder={t('profileEditor.namePlaceholder')}
                  aria-invalid={touched.name && nameMissing}
                />
              </FormField>
              {form.name.trim() && (
                <p className="-mt-4 text-[10px] text-fg-faint">
                  {t('profileEditor.slug')}: <span className="font-mono text-fg-muted">{slug}</span>
                </p>
              )}

              {/* Description */}
              <FormField label={t('common.description')}>
                <Input
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder={t('profileEditor.agentDescriptionPlaceholder')}
                />
              </FormField>

              <FormGrid>
                <FormField label={t('profileEditor.purpose')}>
                  <Input
                    value={form.purpose}
                    onChange={(e) => setForm({ ...form, purpose: e.target.value })}
                    placeholder={t('profileEditor.purposePlaceholder')}
                  />
                </FormField>
                <FormField label={t('profileEditor.audience')}>
                  <Input
                    value={form.audience}
                    onChange={(e) => setForm({ ...form, audience: e.target.value })}
                    placeholder={t('profileEditor.audiencePlaceholder')}
                  />
                </FormField>
              </FormGrid>

              <FormGrid>
                <FormField label={t('profileEditor.riskLevel')}>
                  <Select
                    value={form.risk_level}
                    onChange={(e) => setForm({ ...form, risk_level: e.target.value as ProfileFormData['risk_level'] })}
                  >
                    <option value="low">{t('common.low')}</option>
                    <option value="medium">{t('profileEditor.medium')}</option>
                    <option value="high">{t('common.high')}</option>
                  </Select>
                </FormField>
                <FormField label={t('profileEditor.changeLog')}>
                  <Input
                    value={form.change_log}
                    onChange={(e) => setForm({ ...form, change_log: e.target.value })}
                    placeholder={t(profile ? 'profileEditor.changeLogPlaceholder' : 'profileEditor.initialVersion')}
                  />
                </FormField>
              </FormGrid>

              {profile && (
                <div className="space-y-1 rounded-lg border border-edge bg-surface-muted px-3 py-2 text-xs text-fg-muted">
                  <div>
                    {t('profileEditor.versionSummary', {
                      version: profile.current_version ?? 1,
                      status: profile.lifecycle_status ?? t('common.draft'),
                    })}
                    {isSuper ? ` · ${t('profileEditor.reviewActionsHint')}` : ''}
                  </div>
                  {(profile.lifecycle_status === 'pilot' || profile.lifecycle_status === 'verified') && (
                    <div className="text-warning">{t('profileEditor.reviewedVersionWarning')}</div>
                  )}
                </div>
              )}

              {/* Forked from badge */}
              {profile?.forked_from && (
                <div className="flex items-center gap-1.5 px-3 py-1.5 bg-primary-subtle/50 border border-primary-edge/30 rounded-lg">
                  <span className="text-[10px] text-primary-fg font-medium">
                    ↳ {t('profileEditor.forkedFrom', { name: profile.forked_from })}
                  </span>
                </div>
              )}

              {/* Model — an agent owns its model (v3); it never drifts with the base preset. */}
              <FormField label={t('profileEditor.model')} help={t('profileEditor.modelHint')}>
                <Select value={offeredModelId} onChange={(e) => setForm({ ...form, model_id: e.target.value })}>
                  {(models.length > 0 ? models : [{ id: offeredModelId, name: offeredModelId }]).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id === m.name ? m.id : `${m.id} — ${m.name}`}
                    </option>
                  ))}
                </Select>
              </FormField>

              {/* System Prompt */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-sm font-medium text-fg-secondary">
                    {t('profileEditor.systemPrompt')} <span className="text-danger">*</span>
                  </label>
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-[10px] font-mono ${
                        promptLength > MAX_PROMPT_CHARS ? 'text-danger font-semibold' : 'text-fg-faint'
                      }`}
                    >
                      {promptLength.toLocaleString()} / {MAX_PROMPT_CHARS.toLocaleString()}
                    </span>
                    <button
                      onClick={() => setPromptFullscreen(true)}
                      className="p-1 rounded-md text-fg-faint hover:text-primary-fg hover:bg-primary-subtle transition-colors"
                      title={t('profileEditor.editFullscreen')}
                    >
                      <Maximize2 size={13} />
                    </button>
                  </div>
                </div>
                <Textarea
                  value={form.system_prompt}
                  onChange={(e) => setForm({ ...form, system_prompt: e.target.value })}
                  onBlur={() => setTouched((current) => ({ ...current, systemPrompt: true }))}
                  placeholder={t('profileEditor.systemPromptPlaceholder')}
                  rows={10}
                  aria-invalid={touched.systemPrompt && promptMissing}
                />
                {touched.systemPrompt && promptMissing && (
                  <p className="mt-1 text-xs text-danger">{t('profileEditor.systemPromptRequired')}</p>
                )}
              </div>

              {/* Max Steps */}
              <FormField label={t('profileEditor.maxSteps')} help={t('profileEditor.maxStepsHint')}>
                <Input
                  type="number"
                  value={String(form.max_steps)}
                  onChange={(e) => setForm({ ...form, max_steps: parseInt(e.target.value) || 12 })}
                  size="sm"
                />
              </FormField>
            </div>

            {/* Tool Selection — its own independently scrolling workspace. */}
            <aside className="flex min-h-[24rem] flex-col border-t border-edge bg-surface-sunken/40 lg:min-h-0 lg:border-l lg:border-t-0">
              <div className="flex-shrink-0 space-y-3 border-b border-edge px-4 py-4 sm:px-5">
                <div>
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold text-fg">{t('profileEditor.tools')}</h3>
                    <span className="rounded-full bg-primary-subtle px-2 py-0.5 text-[10px] font-medium text-primary-fg-strong">
                      {t('profileEditor.selected', { count: form.tools.length })}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-fg-muted">{t('profileEditor.toolsHint')}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-label={t('profileEditor.toolLegend')}>
                    <Tag tone="info">{t('profileEditor.read')}</Tag>
                    <Tag tone="danger">{t('profileEditor.write')}</Tag>
                    <Tag tone="warning">{t('profileEditor.confirm')}</Tag>
                    <span className="text-[10px] text-fg-faint">{t('profileEditor.writeConfirmHint')}</span>
                  </div>
                </div>
                <Input
                  value={toolSearch}
                  onChange={(e) => setToolSearch(e.target.value)}
                  placeholder={t('profileEditor.filterTools')}
                  size="sm"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="secondary" size="sm" onClick={selectAllTools}>
                    {t('profileEditor.selectAll')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={clearAllTools}>
                    {t('profileEditor.clear')}
                  </Button>
                  <button
                    type="button"
                    aria-pressed={selectedToolsOnly}
                    onClick={() => setSelectedToolsOnly((current) => !current)}
                    className={`ml-auto rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                      selectedToolsOnly
                        ? 'border-primary-edge bg-primary-subtle text-primary-fg-strong'
                        : 'border-edge bg-surface-raised text-fg-muted hover:bg-surface-muted hover:text-fg'
                    }`}
                  >
                    {t('profileEditor.selectedOnly')}
                  </button>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
                {(['core', 'team', 'admin'] as const).map((cat) => {
                  const tools = toolGroups[cat];
                  if (!tools || tools.length === 0) return null;
                  return (
                    <div key={cat}>
                      <div className="sticky top-0 z-[1] border-b border-edge bg-surface-sunken px-4 py-2">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
                          {t(groupLabels[cat])}
                        </span>
                      </div>
                      {tools.map((tool) => {
                        const Icon = getToolIcon(tool.id);
                        const isSelected = form.tools.includes(tool.id);
                        const fallbackBrief = getToolBrief(tool.id);
                        const brief =
                          tool.brief?.trim() ||
                          (fallbackBrief && fallbackBrief !== tool.id ? fallbackBrief : undefined);
                        const proxyAccess = tool.surface?.proxy;
                        return (
                          <label
                            key={tool.id}
                            className={`flex cursor-pointer items-start gap-2.5 border-b border-edge/60 px-4 py-2.5 transition-colors ${
                              isSelected ? 'bg-primary-subtle' : 'hover:bg-surface-muted'
                            }`}
                          >
                            <Checkbox checked={isSelected} onChange={() => toggleTool(tool.id)} className="mt-0.5" />
                            <Icon
                              size={14}
                              className={`mt-0.5 flex-shrink-0 ${isSelected ? 'text-primary-fg' : 'text-fg-muted'}`}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="flex flex-wrap items-center gap-1.5">
                                <span className="text-xs font-medium text-fg-secondary">{tool.name}</span>
                                {proxyAccess === 'read' && <Tag tone="info">{t('profileEditor.read')}</Tag>}
                                {proxyAccess === 'write' && (
                                  <>
                                    <Tag tone="danger">{t('profileEditor.write')}</Tag>
                                    <Tag tone="warning">{t('profileEditor.confirm')}</Tag>
                                  </>
                                )}
                              </span>
                              {brief && (
                                <span className="mt-0.5 block text-[10px] leading-relaxed text-fg-faint">{brief}</span>
                              )}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  );
                })}
                {Object.values(toolGroups).every((tools) => tools.length === 0) && (
                  <p className="px-4 py-8 text-center text-xs text-fg-muted">{t('profileEditor.noTools')}</p>
                )}
              </div>
            </aside>
          </div>

          {/* Footer */}
          <FormActions
            className="flex-shrink-0 border-t border-edge bg-surface-raised px-4 py-3 sm:px-6"
            leading={
              <p className="text-[10px] text-fg-faint">
                <span className="text-danger">*</span> {t('profileEditor.requiredHint')}
              </p>
            }
          >
            <Button variant="secondary" onClick={requestClose} size="sm">
              {t('common.cancel')}
            </Button>
            <Button onClick={handleSave} disabled={saving || !canSave || (isEditing && !dirty)} size="sm">
              {saving ? <Spinner className="mr-1" /> : null}
              {t(isEditing ? 'profileEditor.saveChanges' : 'profileEditor.createAgent')}
            </Button>
          </FormActions>
        </div>
      </Dialog>
      <ConfirmDialog
        open={discardConfirmOpen}
        onClose={() => setDiscardConfirmOpen(false)}
        onConfirm={() => {
          setDiscardConfirmOpen(false);
          onClose();
        }}
        title={t('profileEditor.discardTitle')}
        description={t('profileEditor.discardDescription')}
        confirmLabel={t('profileEditor.discard')}
        confirmVariant="destructive"
      />
    </>
  );
}
