/**
 * ProfileEditorDrawer — Centered dialog for creating/editing custom Agent profiles.
 * (Name kept for backward compatibility with existing imports.)
 *
 * Features:
 * - Tools grouped by functional domain (Knowledge / Projects / Email / …)
 * - Auto-generated slug display (read-only)
 * - System prompt character counter (xxx / 8000)
 * - Capabilities (quick actions) editor with icon picker
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Button, Dialog, Input, Textarea, Select, Spinner } from '../ui';
import { Globe, X, Plus, Trash2, ChevronDown, ChevronUp, Maximize2, CAPABILITY_ICON_LIST } from '../../lib/icons';
import { getToolIcon, getToolBrief } from '../../lib/icons';
import { SproutyDesigner, DEFAULT_SPROUTY_DESIGN, type SproutyDesignValue } from '../sprouty/index.js';
import type { Profile, ToolMeta, CustomProfileInput } from '../../lib/api';

const MAX_PROMPT_CHARS = 8000;
const MAX_CAPABILITIES = 6;

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
  tools: string[];
  system_prompt: string;
  capabilities: Array<{ icon: string; label: string; prompt: string }>;
  max_steps: number;
  is_shared: boolean;
  avatar: SproutyDesignValue;
  // Safe model knobs + behavior ('' = inherit base)
  model_thinking: '' | 'on' | 'off';
  model_temperature: string;
  model_max_tokens: string;
  default_language: string;
  greeting: string;
  suggested_followups: string; // newline-separated
}

interface ProfileEditorDrawerProps {
  open: boolean;
  onClose: () => void;
  profile: Profile | null; // null = create mode
  availableTools: ToolMeta[];
  isSuper: boolean;
  onSave: (input: CustomProfileInput, editId?: number) => Promise<void>;
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
  const isEditing = !!profile;

  const [form, setForm] = useState<ProfileFormData>({
    name: '',
    description: '',
    base_profile_id: 'default',
    tools: [],
    system_prompt: '',
    capabilities: [],
    max_steps: 12,
    is_shared: false,
    avatar: DEFAULT_SPROUTY_DESIGN,
    model_thinking: '',
    model_temperature: '',
    model_max_tokens: '',
    default_language: '',
    greeting: '',
    suggested_followups: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [toolSearch, setToolSearch] = useState('');
  const [showCapabilities, setShowCapabilities] = useState(false);
  const [promptFullscreen, setPromptFullscreen] = useState(false);

  // Reset form when profile changes
  useEffect(() => {
    if (open) {
      if (profile) {
        setForm({
          name: profile.name,
          description: profile.description || '',
          base_profile_id: profile.base_profile_id || 'default',
          tools: profile.tools || [],
          system_prompt: profile.system_prompt || '',
          capabilities: profile.capabilities || [],
          max_steps: profile.max_steps || 12,
          is_shared: profile.is_shared || false,
          avatar: {
            color: (profile as any).avatar?.color || 'forest',
            accessories: (profile as any).avatar?.accessories || [],
            leafStyle: (profile as any).avatar?.leafStyle || 'normal',
            faceStyle: (profile as any).avatar?.faceStyle || undefined,
            palette: (profile as any).avatar?.palette || undefined,
          },
          model_thinking:
            profile.model_options?.thinking === undefined ? '' : profile.model_options.thinking ? 'on' : 'off',
          model_temperature:
            profile.model_options?.temperature != null ? String(profile.model_options.temperature) : '',
          model_max_tokens: profile.model_options?.max_tokens != null ? String(profile.model_options.max_tokens) : '',
          default_language: profile.default_language || '',
          greeting: profile.greeting || '',
          suggested_followups: (profile.suggested_followups || []).join('\n'),
        });
        setShowCapabilities((profile.capabilities?.length ?? 0) > 0);
      } else {
        setForm({
          name: '',
          description: '',
          base_profile_id: 'default',
          tools: [],
          system_prompt: '',
          capabilities: [],
          max_steps: 12,
          is_shared: false,
          avatar: DEFAULT_SPROUTY_DESIGN,
          model_thinking: '',
          model_temperature: '',
          model_max_tokens: '',
          default_language: '',
          greeting: '',
          suggested_followups: '',
        });
        setShowCapabilities(false);
      }
      setError('');
      setToolSearch('');
      setPromptFullscreen(false);
    }
  }, [open, profile]);

  // Group tools by functional domain. availableTools arrives already ordered by
  // group (then name) from /api/tools, so a Map preserves that section order.
  const toolGroups = useMemo(() => {
    const groups = new Map<string, ToolMeta[]>();
    const search = toolSearch.toLowerCase();
    for (const t of availableTools) {
      if (search && !t.name.toLowerCase().includes(search) && !t.id.toLowerCase().includes(search)) continue;
      const g = t.group || 'other';
      const bucket = groups.get(g);
      if (bucket) bucket.push(t);
      else groups.set(g, [t]);
    }
    return groups;
  }, [availableTools, toolSearch]);

  const slug = useMemo(() => slugify(form.name), [form.name]);
  const promptLength = form.system_prompt.length;

  const toggleTool = (toolId: string) => {
    setForm((prev) => ({
      ...prev,
      tools: prev.tools.includes(toolId) ? prev.tools.filter((t) => t !== toolId) : [...prev.tools, toolId],
    }));
  };

  const selectAllTools = () => {
    setForm((prev) => ({ ...prev, tools: availableTools.map((t) => t.id) }));
  };

  const clearAllTools = () => {
    setForm((prev) => ({ ...prev, tools: [] }));
  };

  const addCapability = () => {
    if (form.capabilities.length >= MAX_CAPABILITIES) return;
    setForm((prev) => ({
      ...prev,
      capabilities: [...prev.capabilities, { icon: 'Search', label: '', prompt: '' }],
    }));
  };

  const updateCapability = (idx: number, field: string, value: string) => {
    setForm((prev) => ({
      ...prev,
      capabilities: prev.capabilities.map((c, i) => (i === idx ? { ...c, [field]: value } : c)),
    }));
  };

  const removeCapability = (idx: number) => {
    setForm((prev) => ({
      ...prev,
      capabilities: prev.capabilities.filter((_, i) => i !== idx),
    }));
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      setError('Name is required');
      return;
    }
    if (!form.system_prompt.trim()) {
      setError('System prompt is required');
      return;
    }
    if (promptLength > MAX_PROMPT_CHARS) {
      setError(`System prompt exceeds ${MAX_PROMPT_CHARS} character limit`);
      return;
    }

    setSaving(true);
    setError('');
    try {
      const modelOptions: { thinking?: boolean; temperature?: number; max_tokens?: number } = {};
      if (form.model_thinking) modelOptions.thinking = form.model_thinking === 'on';
      if (form.model_temperature !== '') modelOptions.temperature = parseFloat(form.model_temperature);
      if (form.model_max_tokens !== '') modelOptions.max_tokens = parseInt(form.model_max_tokens, 10);
      const followups = form.suggested_followups
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 4);
      const input: CustomProfileInput = {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        base_profile_id: form.base_profile_id,
        tools: form.tools,
        system_prompt: form.system_prompt.trim(),
        capabilities: form.capabilities.filter((c) => c.label.trim() && c.prompt.trim()),
        max_steps: form.max_steps,
        is_shared: form.is_shared,
        avatar: {
          color: form.avatar.color,
          accessories: form.avatar.accessories,
          leafStyle: form.avatar.leafStyle,
          ...(form.avatar.faceStyle ? { faceStyle: form.avatar.faceStyle } : {}),
          ...(form.avatar.palette ? { palette: form.avatar.palette } : {}),
        },
        model_options: Object.keys(modelOptions).length ? modelOptions : undefined,
        default_language: form.default_language.trim() || undefined,
        greeting: form.greeting.trim() || undefined,
        suggested_followups: followups.length ? followups : undefined,
      };

      const editId = profile ? parseInt(profile.id.replace('custom:', ''), 10) : undefined;
      await onSave(input, editId);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to save');
    }
    setSaving(false);
  };

  const groupLabels: Record<string, string> = {
    knowledge: 'Knowledge',
    projects: 'Projects & Tasks',
    email: 'Email',
    sessions: 'Sessions & Delegation',
    skills: 'Skill Center',
    web: 'Web & Search',
    media: 'Media',
    compute: 'Compute',
    interaction: 'Interaction',
    admin: 'Admin & Analytics',
    other: 'Other',
  };

  return (
    <Dialog open={open} onClose={onClose} title={isEditing ? 'Edit Profile' : 'Create Profile'} size="lg" noPadding>
      {/* Fullscreen Prompt Editor Overlay */}
      {promptFullscreen && (
        <div className="absolute inset-0 z-10 bg-surface-raised flex flex-col rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-edge flex-shrink-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-fg-secondary">System Prompt</h3>
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
              title="Exit fullscreen"
            >
              <X size={16} />
            </button>
          </div>
          <div className="flex-1 p-4">
            <textarea
              value={form.system_prompt}
              onChange={(e) => setForm({ ...form, system_prompt: e.target.value })}
              placeholder="Define the agent's personality, behavior, and instructions..."
              className="w-full h-full resize-none rounded-lg border border-edge bg-surface-sunken px-4 py-3 text-sm text-fg-secondary placeholder:text-fg-faint focus:outline-none focus:ring-1 focus:ring-primary-edge font-mono leading-relaxed"
            />
          </div>
        </div>
      )}
      {/* Body */}
      <div className="px-6 py-4 space-y-5">
        {error && <div className="text-sm text-danger bg-danger-subtle px-3 py-2 rounded-lg">{error}</div>}

        {/* Avatar — shared Sprouty designer (also used by the Branding Studio) */}
        <SproutyDesigner value={form.avatar} onChange={(avatar) => setForm({ ...form, avatar })} />

        {/* Name + Slug */}
        <div>
          <label className="text-sm font-medium text-fg-secondary block mb-1">Name</label>
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="My Research Assistant"
          />
          {form.name.trim() && (
            <p className="text-[10px] text-fg-faint mt-1">
              Slug: <span className="font-mono text-fg-muted">{slug}</span>
            </p>
          )}
        </div>

        {/* Description */}
        <div>
          <label className="text-sm font-medium text-fg-secondary block mb-1">Description</label>
          <Input
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="Brief description of this profile's purpose"
          />
        </div>

        {/* Forked from badge */}
        {profile?.forked_from && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-primary-subtle/50 border border-primary-edge/30 rounded-lg">
            <span className="text-[10px] text-primary-fg font-medium">↳ Forked from: {profile.forked_from}</span>
          </div>
        )}

        {/* Base Profile */}
        <div>
          <label className="text-sm font-medium text-fg-secondary block mb-1">Base Profile</label>
          <Select value={form.base_profile_id} onChange={(e) => setForm({ ...form, base_profile_id: e.target.value })}>
            <option value="default">Default (Public)</option>
            <option value="team">Team (Internal)</option>
          </Select>
          <p className="text-[10px] text-fg-faint mt-1">Inherits model configuration from the base profile</p>
        </div>

        {/* Tool Selection — Grouped */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-fg-secondary">Tools ({form.tools.length} selected)</label>
            <div className="flex items-center gap-2">
              <button onClick={selectAllTools} className="text-[10px] text-primary-fg hover:underline">
                All
              </button>
              <span className="text-[10px] text-fg-faint">|</span>
              <button onClick={clearAllTools} className="text-[10px] text-fg-muted hover:underline">
                None
              </button>
            </div>
          </div>

          {/* Tool search */}
          <div className="mb-2">
            <Input
              value={toolSearch}
              onChange={(e) => setToolSearch(e.target.value)}
              placeholder="Filter tools..."
              size="sm"
            />
          </div>

          <div className="border border-edge rounded-lg max-h-56 overflow-y-auto">
            {[...toolGroups.entries()].map(([groupId, tools]) => {
              if (!tools || tools.length === 0) return null;
              return (
                <div key={groupId}>
                  <div className="px-3 py-1.5 bg-surface-sunken border-b border-edge sticky top-0 z-[1]">
                    <span className="text-[10px] font-semibold text-fg-faint uppercase tracking-wider">
                      {groupLabels[groupId] ?? groupId}
                    </span>
                  </div>
                  {tools.map((tool) => {
                    const Icon = getToolIcon(tool.id);
                    const isSelected = form.tools.includes(tool.id);
                    return (
                      <label
                        key={tool.id}
                        className={`flex items-center gap-2.5 px-3 py-1.5 cursor-pointer transition-colors ${
                          isSelected ? 'bg-primary-subtle' : 'hover:bg-surface-sunken'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleTool(tool.id)}
                          className="rounded border-edge flex-shrink-0"
                        />
                        <Icon size={13} className={isSelected ? 'text-primary-fg' : 'text-fg-muted'} />
                        <div className="flex-1 min-w-0">
                          <span className="text-xs font-medium text-fg-secondary">{tool.name}</span>
                          <span className="text-[10px] text-fg-faint ml-2 hidden sm:inline">
                            {getToolBrief(tool.id)}
                          </span>
                        </div>
                      </label>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        {/* System Prompt */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-sm font-medium text-fg-secondary">System Prompt</label>
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
                title="Edit fullscreen"
              >
                <Maximize2 size={13} />
              </button>
            </div>
          </div>
          <Textarea
            value={form.system_prompt}
            onChange={(e) => setForm({ ...form, system_prompt: e.target.value })}
            placeholder="Define the agent's personality, behavior, and instructions..."
            rows={10}
          />
        </div>

        {/* Max Steps */}
        <div>
          <label className="text-sm font-medium text-fg-secondary block mb-1">Max Steps</label>
          <Input
            type="number"
            value={String(form.max_steps)}
            onChange={(e) => setForm({ ...form, max_steps: parseInt(e.target.value) || 12 })}
            size="sm"
          />
          <p className="text-[10px] text-fg-faint mt-1">Maximum tool call iterations per response</p>
        </div>

        {/* Model options */}
        <div>
          <label className="text-sm font-medium text-fg-secondary block mb-1">Model options</label>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <span className="text-[10px] text-fg-faint block mb-1">Thinking</span>
              <Select
                value={form.model_thinking}
                onChange={(e) => setForm({ ...form, model_thinking: e.target.value as '' | 'on' | 'off' })}
              >
                <option value="">Inherit</option>
                <option value="on">On</option>
                <option value="off">Off</option>
              </Select>
            </div>
            <div>
              <span className="text-[10px] text-fg-faint block mb-1">Temperature</span>
              <Input
                type="number"
                value={form.model_temperature}
                placeholder="inherit"
                onChange={(e) => setForm({ ...form, model_temperature: e.target.value })}
                size="sm"
              />
            </div>
            <div>
              <span className="text-[10px] text-fg-faint block mb-1">Max tokens</span>
              <Input
                type="number"
                value={form.model_max_tokens}
                placeholder="inherit"
                onChange={(e) => setForm({ ...form, model_max_tokens: e.target.value })}
                size="sm"
              />
            </div>
          </div>
          <p className="text-[10px] text-fg-faint mt-1">
            Override the base model's sampling. Empty = inherit from the base profile.
          </p>
        </div>

        {/* Default language */}
        <div>
          <label className="text-sm font-medium text-fg-secondary block mb-1">Default language</label>
          <Input
            value={form.default_language}
            placeholder="e.g. English, 中文 — blank follows the user"
            onChange={(e) => setForm({ ...form, default_language: e.target.value })}
          />
        </div>

        {/* Greeting */}
        <div>
          <label className="text-sm font-medium text-fg-secondary block mb-1">Greeting</label>
          <Textarea
            value={form.greeting}
            placeholder="Shown on the empty chat screen before the first message."
            rows={2}
            onChange={(e) => setForm({ ...form, greeting: e.target.value })}
          />
        </div>

        {/* Suggested follow-ups */}
        <div>
          <label className="text-sm font-medium text-fg-secondary block mb-1">Suggested follow-ups</label>
          <Textarea
            value={form.suggested_followups}
            placeholder={'One per line (max 4)\nSummarize the latest report\nDraft a follow-up email'}
            rows={3}
            onChange={(e) => setForm({ ...form, suggested_followups: e.target.value })}
          />
          <p className="text-[10px] text-fg-faint mt-1">
            One per line, up to 4. Shown as quick prompts on the empty chat screen.
          </p>
        </div>

        {/* Shared toggle */}
        {isSuper && (
          <label className="flex items-center gap-2 text-sm text-fg-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={form.is_shared}
              onChange={(e) => setForm({ ...form, is_shared: e.target.checked })}
              className="rounded border-edge"
            />
            <Globe size={14} className="text-fg-muted" />
            Share with all internal users
          </label>
        )}

        {/* Capabilities (collapsible advanced section) */}
        <div className="border border-edge rounded-lg overflow-hidden">
          <button
            onClick={() => setShowCapabilities(!showCapabilities)}
            className="w-full flex items-center justify-between px-3 py-2.5 bg-surface-sunken hover:bg-surface-muted transition-colors"
          >
            <span className="text-xs font-medium text-fg-secondary">Capabilities ({form.capabilities.length})</span>
            {showCapabilities ? (
              <ChevronUp size={14} className="text-fg-faint" />
            ) : (
              <ChevronDown size={14} className="text-fg-faint" />
            )}
          </button>

          {showCapabilities && (
            <div className="p-3 space-y-3">
              <p className="text-[10px] text-fg-faint">
                Quick action buttons shown on the empty chat screen. Max {MAX_CAPABILITIES}.
              </p>

              {form.capabilities.map((cap, idx) => (
                <div key={idx} className="border border-edge rounded-lg p-2.5 space-y-2 bg-surface-sunken">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-medium text-fg-faint">Capability {idx + 1}</span>
                    <button
                      onClick={() => removeCapability(idx)}
                      className="p-0.5 text-fg-faint hover:text-danger rounded transition-colors"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>

                  {/* Icon picker */}
                  <div className="flex items-center gap-2">
                    <label className="text-[10px] text-fg-muted w-10 flex-shrink-0">Icon</label>
                    <div className="flex gap-1 flex-wrap">
                      {CAPABILITY_ICON_LIST.map(({ name, Icon }) => {
                        const selected = cap.icon === name;
                        return (
                          <button
                            key={name}
                            onClick={() => updateCapability(idx, 'icon', name)}
                            title={name}
                            className={`w-6 h-6 rounded flex items-center justify-center transition-colors ${
                              selected
                                ? 'bg-primary-subtle text-primary-fg ring-1 ring-primary-edge'
                                : 'hover:bg-surface-muted text-fg-faint'
                            }`}
                          >
                            <Icon size={12} />
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Label */}
                  <div className="flex items-center gap-2">
                    <label className="text-[10px] text-fg-muted w-10 flex-shrink-0">Label</label>
                    <Input
                      value={cap.label}
                      onChange={(e) => updateCapability(idx, 'label', e.target.value)}
                      placeholder="Search products"
                      size="sm"
                    />
                  </div>

                  {/* Prompt */}
                  <div className="flex items-center gap-2">
                    <label className="text-[10px] text-fg-muted w-10 flex-shrink-0">Prompt</label>
                    <Input
                      value={cap.prompt}
                      onChange={(e) => updateCapability(idx, 'prompt', e.target.value)}
                      placeholder="Help me search the knowledge base for "
                      size="sm"
                    />
                  </div>
                </div>
              ))}

              {form.capabilities.length < MAX_CAPABILITIES && (
                <button
                  onClick={addCapability}
                  className="w-full flex items-center justify-center gap-1.5 py-2 text-xs text-primary-fg hover:bg-primary-subtle rounded-lg transition-colors"
                >
                  <Plus size={13} />
                  Add Capability
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="sticky bottom-0 flex items-center justify-end gap-2 px-6 py-3 border-t border-edge bg-surface-raised">
        <Button variant="secondary" onClick={onClose} size="sm">
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={saving} size="sm">
          {saving ? <Spinner className="mr-1" /> : null}
          {isEditing ? 'Save Changes' : 'Create'}
        </Button>
      </div>
    </Dialog>
  );
}
