/**
 * Unified user permission modal.
 *
 * One place for "what can this user do", organized by feature point. The tabs
 * follow the server registry's `group` (apps/api/src/platform/feature-points.ts):
 *  - Basic access — default-on features (Tables / Missions / AI Memory) with
 *    per-user off switches, plus the read-only always-on global tools.
 *  - App access — application points (Knowledge / Projects / Tables) with
 *    finer capability + record/field controls where app-backed.
 *  - Advanced access — opt-in flags (Knowledge Sync) and the individually
 *    granted "Advanced tools" bucket.
 *  - Usage limits — monthly token cap.
 *
 * The view is composed server-side (GET /api/admin/users/:id/access); writes fan out
 * to the existing granular endpoints (features / platform overrides / entity-policies
 * / tools). Replaces the separate tool-assignment and feature-toggle dialogs and the
 * standalone App Permissions page.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Dialog, Input, Select, Spinner, Tag, Toggle, toast } from '../../components/ui';
import { authFetch } from '../../lib/auth';
import { fetchUserAccess, setUserTools, type UserAccessView, type AccessFeaturePoint } from '../../lib/api/admin';
import { formatTokens } from '../../lib/api';
import {
  BookOpen,
  Brain,
  ClipboardList,
  Cloud,
  Info,
  Lock,
  RefreshCw,
  Table2,
  TrendingUp,
  Users,
  Wrench,
} from '../../lib/icons';
import { getToolIcon } from '../../lib/icons';
import type { LucideIcon } from '../../lib/icons';
import { useT } from '../../lib/i18n';

type Tab = 'basic' | 'apps' | 'advanced' | 'limits';

type AccessEntity = NonNullable<AccessFeaturePoint['entities']>[number];
type ReadMode = 'full' | 'masked' | 'none';
type FieldPolicy = { read: ReadMode; write: boolean; export: boolean };
type OverrideMode = 'inherit' | 'allow' | 'deny';

const FEATURE_ICONS: Record<string, LucideIcon> = {
  Users,
  BookOpen,
  ClipboardList,
  Brain,
  Cloud,
  RefreshCw,
  Table2,
  TrendingUp,
  Wrench,
};

function FeatureIcon({ name, className }: { name: string; className?: string }) {
  const Icon = FEATURE_ICONS[name] ?? Wrench;
  return <Icon size={18} className={className} />;
}

// ─── Entity record/field editor ──────────────────────────

function scopeKinds(entity: AccessEntity): string[] {
  const override = entity.override;
  if (override?.effect === 'allow' && override.policy) return override.policy.scopes.map((s) => s.kind);
  if (override?.effect === 'deny') return [];
  return entity.effectivePolicy.scopes;
}

function fieldPolicies(entity: AccessEntity): Record<string, FieldPolicy> {
  const override = entity.override;
  const source =
    override?.effect === 'allow' && override.policy
      ? (override.policy.fields as Record<string, FieldPolicy>)
      : override?.effect === 'deny'
        ? {}
        : (entity.effectivePolicy.fields as Record<string, FieldPolicy>);
  const base: Record<string, FieldPolicy> = {};
  for (const field of entity.fields) {
    base[field.id] = source[field.id] ?? { read: 'none', write: false, export: false };
  }
  return base;
}

function EntityPolicyEditor({
  userId,
  entity,
  disabled,
  onSaved,
}: {
  userId: string;
  entity: AccessEntity;
  disabled: boolean;
  onSaved: () => Promise<void>;
}) {
  const t = useT();
  const [mode, setMode] = useState<OverrideMode>(entity.override?.effect ?? 'inherit');
  const [scopes, setScopes] = useState<Set<string>>(() => new Set(scopeKinds(entity)));
  const [fields, setFields] = useState<Record<string, FieldPolicy>>(() => fieldPolicies(entity));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setMode(entity.override?.effect ?? 'inherit');
    setScopes(new Set(scopeKinds(entity)));
    setFields(fieldPolicies(entity));
  }, [entity]);

  const toggleScope = (scope: string) =>
    setScopes((current) => {
      const next = new Set(current);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });

  const updateField = (fieldId: string, patch: Partial<FieldPolicy>) =>
    setFields((current) => ({
      ...current,
      [fieldId]: { ...(current[fieldId] ?? { read: 'none', write: false, export: false }), ...patch },
    }));

  const save = async () => {
    setSaving(true);
    try {
      const endpoint = `/api/admin/platform/users/${encodeURIComponent(userId)}/entity-policies/${entity.appId}/${entity.entityId}`;
      const res =
        mode === 'inherit'
          ? await authFetch(endpoint, { method: 'DELETE' })
          : await authFetch(endpoint, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                effect: mode,
                scopes:
                  mode === 'deny'
                    ? []
                    : [...scopes].map((kind) =>
                        kind === 'department' || kind === 'departmentTree' ? { kind, departmentIds: [] } : { kind },
                      ),
                fields: mode === 'deny' ? {} : fields,
                reason: `Updated from permission modal (${entity.appId}.${entity.entityId})`,
              }),
            });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || t('permissions.savePolicyFailed'));
      }
      toast(t('permissions.policySaved'), 'success');
      await onSaved();
    } catch (error) {
      toast(error instanceof Error ? error.message : t('permissions.savePolicyFailed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <details className="rounded-lg border border-edge bg-surface-raised">
      <summary className="cursor-pointer list-none px-3 py-2 flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-fg">{entity.title}</span>
        <Tag tone={mode === 'deny' ? 'danger' : mode === 'allow' ? 'primary' : 'neutral'}>
          {t(`permissions.mode.${mode}`)}
        </Tag>
      </summary>
      <div className="border-t border-edge p-3 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-fg-secondary w-24">{t('permissions.override')}</span>
          <Select
            size="sm"
            value={mode}
            disabled={disabled}
            onChange={(e) => setMode(e.target.value as OverrideMode)}
            aria-label={t('permissions.overrideMode', { name: entity.title })}
          >
            <option value="inherit">{t('permissions.inheritRoles')}</option>
            <option value="allow">{t('permissions.customAllow')}</option>
            <option value="deny">{t('permissions.denyRecordType')}</option>
          </Select>
        </div>

        {mode === 'allow' && (
          <>
            <div>
              <div className="text-xs font-medium text-fg-secondary mb-1.5">{t('permissions.recordScope')}</div>
              <div className="flex flex-wrap gap-3">
                {entity.accessScopes.map((scope) => (
                  <Checkbox
                    key={scope}
                    label={t(`permissions.scope.${scope}` as Parameters<typeof t>[0])}
                    checked={scopes.has(scope)}
                    onChange={() => toggleScope(scope)}
                    disabled={disabled}
                    className="text-xs"
                  />
                ))}
              </div>
            </div>
            <div className="overflow-x-auto rounded-lg border border-edge">
              <table className="w-full min-w-[480px] text-xs">
                <thead className="bg-surface-sunken text-fg-muted">
                  <tr>
                    <th className="text-left px-2.5 py-1.5">{t('permissions.field')}</th>
                    <th className="text-left px-2.5 py-1.5">{t('permissions.classification')}</th>
                    <th className="text-left px-2.5 py-1.5">{t('permissions.read')}</th>
                    <th className="text-center px-2.5 py-1.5">{t('permissions.write')}</th>
                    <th className="text-center px-2.5 py-1.5">{t('permissions.export')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge">
                  {entity.fields.map((field) => {
                    const policy = fields[field.id] ?? { read: 'none', write: false, export: false };
                    return (
                      <tr key={field.id}>
                        <td className="px-2.5 py-1.5 font-medium text-fg">{field.title}</td>
                        <td className="px-2.5 py-1.5">
                          <Tag
                            tone={
                              field.classification === 'restricted'
                                ? 'danger'
                                : field.classification === 'confidential'
                                  ? 'warning'
                                  : 'neutral'
                            }
                          >
                            {t(`permissions.class.${field.classification}` as Parameters<typeof t>[0])}
                          </Tag>
                        </td>
                        <td className="px-2.5 py-1.5">
                          <Select
                            size="sm"
                            value={policy.read}
                            disabled={disabled}
                            onChange={(e) => updateField(field.id, { read: e.target.value as ReadMode })}
                            aria-label={t('permissions.readField', { name: field.title })}
                          >
                            <option value="full">{t('permissions.full')}</option>
                            <option value="masked">{t('permissions.masked')}</option>
                            <option value="none">{t('permissions.hidden')}</option>
                          </Select>
                        </td>
                        <td className="px-2.5 py-1.5 text-center">
                          <Checkbox
                            checked={policy.write}
                            disabled={disabled || policy.read === 'none'}
                            onChange={(e) => updateField(field.id, { write: e.target.checked })}
                            aria-label={t('permissions.writeField', { name: field.title })}
                          />
                        </td>
                        <td className="px-2.5 py-1.5 text-center">
                          <Checkbox
                            checked={policy.export}
                            disabled={disabled || policy.read === 'none'}
                            onChange={(e) => updateField(field.id, { export: e.target.checked })}
                            aria-label={t('permissions.exportField', { name: field.title })}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div className="flex justify-end">
          <Button size="sm" onClick={save} disabled={saving || disabled}>
            {saving ? t('common.saving') : t('permissions.saveRecordPolicy')}
          </Button>
        </div>
      </div>
    </details>
  );
}

// ─── Feature point card ──────────────────────────────────

function FeaturePointCard({
  userId,
  point,
  busy,
  onToggleMain,
  onSetCapability,
  onToggleTool,
  onReload,
}: {
  userId: string;
  point: AccessFeaturePoint;
  busy: boolean;
  onToggleMain: (point: AccessFeaturePoint, next: boolean) => void;
  onSetCapability: (capability: string, mode: OverrideMode) => void;
  onToggleTool: (toolId: string, assigned: boolean) => void;
  onReload: () => Promise<void>;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const isApp = point.kind === 'app';
  const isToolset = point.kind === 'toolset';
  const hasFiner = isApp && ((point.capabilities?.length ?? 0) > 0 || (point.entities?.length ?? 0) > 0);
  // App-level off disables the finer controls (a disabled feature isn't fine-tuned).
  const finerDisabled = busy || !point.enabled;

  return (
    <div className="rounded-xl border border-edge bg-surface-raised overflow-hidden">
      <div className="flex items-center gap-3 px-3.5 py-3">
        <span className="w-9 h-9 rounded-lg bg-surface-sunken flex items-center justify-center flex-shrink-0">
          <FeatureIcon name={point.icon} className="text-fg-secondary" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-fg">{point.title}</div>
          <div className="text-xs text-fg-muted mt-0.5">{point.description}</div>
        </div>
        {(hasFiner || isToolset) && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-[11px] text-fg-faint hover:text-fg-secondary px-2 py-1 rounded"
          >
            {expanded ? t('permissions.hide') : isToolset ? t('permissions.tools') : t('permissions.details')}
          </button>
        )}
        {!isToolset && point.mainControl && (
          <Toggle checked={point.enabled} disabled={busy} onChange={(next) => onToggleMain(point, next)} />
        )}
        {isToolset && (
          <span className="text-[11px] text-fg-faint whitespace-nowrap">
            {t('permissions.toolsOn', {
              enabled: (point.tools ?? []).filter((tool) => tool.assigned).length,
              total: point.tools?.length ?? 0,
            })}
          </span>
        )}
      </div>

      {expanded && (isToolset || hasFiner) && (
        <div className="border-t border-edge bg-surface-sunken px-3.5 py-3 space-y-3">
          {isApp && !point.enabled && (
            <p className="text-[11px] text-fg-muted flex items-center gap-1.5">
              <Info size={12} /> {t('permissions.enableToFineTune')}
            </p>
          )}

          {isApp && (point.capabilities?.length ?? 0) > 0 && (
            <div className="space-y-1">
              <div className="text-[11px] font-semibold text-fg-faint uppercase tracking-wider">
                {t('common.actions')}
              </div>
              {point.capabilities!.map((cap) => (
                <div key={cap.capability} className="grid grid-cols-[minmax(0,1fr)_112px] items-center gap-3 py-1">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-fg truncate" title={cap.capability}>
                      {cap.capability}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <Tag tone={cap.allowed ? 'success' : 'danger'}>
                        {cap.allowed ? t('permissions.allowed') : t('permissions.denied')}
                      </Tag>
                      <span className="text-[10px] text-fg-faint truncate">{cap.reason}</span>
                    </div>
                  </div>
                  <Select
                    size="sm"
                    value={cap.override}
                    disabled={finerDisabled}
                    onChange={(e) => onSetCapability(cap.capability, e.target.value as OverrideMode)}
                    aria-label={t('permissions.overrideCapability', { name: cap.capability })}
                  >
                    <option value="inherit">{t('permissions.inherit')}</option>
                    <option value="allow">{t('permissions.allow')}</option>
                    <option value="deny">{t('permissions.deny')}</option>
                  </Select>
                </div>
              ))}
            </div>
          )}

          {isApp && (point.entities?.length ?? 0) > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-semibold text-fg-faint uppercase tracking-wider">
                {t('permissions.recordsAndFields')}
              </div>
              {point.entities!.map((entity) => (
                <EntityPolicyEditor
                  key={`${entity.appId}:${entity.entityId}`}
                  userId={userId}
                  entity={entity}
                  disabled={finerDisabled}
                  onSaved={onReload}
                />
              ))}
            </div>
          )}

          {isToolset &&
            (point.tools ?? []).map((toolItem) => {
              const Icon = getToolIcon(toolItem.id);
              return (
                <div key={toolItem.id} className="flex items-center gap-2.5 py-1">
                  <Icon size={14} className="text-fg-faint flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <span className="text-xs font-medium text-fg-secondary">{toolItem.name}</span>
                    <span className="text-[11px] text-fg-faint ml-2">{toolItem.brief}</span>
                  </div>
                  <Toggle
                    size="sm"
                    checked={toolItem.assigned}
                    disabled={busy}
                    onChange={(next) => onToggleTool(toolItem.id, next)}
                  />
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

// ─── Always-on global tools (Basic tab footer) ───────────

function GlobalToolsSection({ baseline }: { baseline: UserAccessView['baseline'] }) {
  const t = useT();
  return (
    <div className="space-y-1.5 pt-1">
      <div className="text-[11px] font-semibold text-fg-faint uppercase tracking-wider">
        {t('permissions.globalTools')}
      </div>
      <p className="text-xs text-fg-muted leading-relaxed flex items-start gap-1.5">
        <Lock size={13} className="mt-0.5 flex-shrink-0" />
        <span>{t('permissions.globalToolsAlwaysOn')}</span>
      </p>
      <div className="flex flex-wrap gap-1.5">
        {baseline.globalTools.map((toolItem) => (
          <span
            key={toolItem.id}
            className="text-[11px] px-2 py-1 rounded-full bg-surface-sunken text-fg-secondary"
            title={toolItem.brief}
          >
            {toolItem.name}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Limits tab ──────────────────────────────────────────

function LimitsTab({
  userId,
  limits,
  onSaved,
}: {
  userId: string;
  limits: UserAccessView['limits'];
  onSaved: () => Promise<void>;
}) {
  const t = useT();
  const [monthly, setMonthly] = useState(limits.monthly_token_limit);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setMonthly(limits.monthly_token_limit);
  }, [limits]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await authFetch(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ monthly_token_limit: monthly }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || t('permissions.saveLimitsFailed'));
      }
      toast(t('permissions.limitsSaved'), 'success');
      await onSaved();
    } catch (error) {
      toast(error instanceof Error ? error.message : t('permissions.saveLimitsFailed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 max-w-sm">
      <label className="block">
        <span className="text-xs font-medium text-fg-secondary">{t('permissions.monthlyTokenLimit')}</span>
        <Input
          type="number"
          value={monthly}
          onChange={(e) => setMonthly(parseInt(e.target.value) || 0)}
          className="mt-1 w-40"
        />
        <span className="block text-[11px] text-fg-faint mt-1">
          {t('permissions.tokensPerMonth', { count: formatTokens(monthly) })}
        </span>
      </label>
      <div className="flex justify-end">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? t('common.saving') : t('permissions.saveLimits')}
        </Button>
      </div>
    </div>
  );
}

// ─── Modal ───────────────────────────────────────────────

export interface PermissionModalUser {
  id: string;
  nickname: string;
  email: string;
  role: string;
}

export function UserPermissionsModal({
  user,
  open,
  onClose,
}: {
  user: PermissionModalUser | null;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('basic');
  const [data, setData] = useState<UserAccessView | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      setData(await fetchUserAccess(user.id));
    } catch {
      toast(t('permissions.loadFailed'), 'error');
    }
  }, [user, t]);

  useEffect(() => {
    if (!open || !user) return;
    setTab('basic');
    setData(null);
    setLoading(true);
    void load().finally(() => setLoading(false));
  }, [open, user, load]);

  const runWrite = useCallback(
    async (fn: () => Promise<Response>) => {
      setBusy(true);
      try {
        const res = await fn();
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || t('permissions.updateFailed'));
        }
        await load();
      } catch (error) {
        toast(error instanceof Error ? error.message : t('permissions.updateFailed'), 'error');
      } finally {
        setBusy(false);
      }
    },
    [load, t],
  );

  const toggleMain = (point: AccessFeaturePoint, next: boolean) => {
    if (!user || !point.mainControl) return;
    const control = point.mainControl;
    if (control.type === 'flag') {
      void runWrite(() =>
        authFetch(`/api/admin/users/${user.id}/features`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ feature: control.flag, enabled: next }),
        }),
      );
    } else {
      // Capability-backed app: off = deny the app.* pattern, on = clear that override.
      const endpoint = `/api/admin/platform/users/${user.id}/overrides`;
      void runWrite(() =>
        next
          ? authFetch(`${endpoint}?capability=${encodeURIComponent(control.capability)}`, { method: 'DELETE' })
          : authFetch(endpoint, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                capability: control.capability,
                effect: 'deny',
                reason: 'Feature disabled from permission modal',
              }),
            }),
      );
    }
  };

  const setCapability = (capability: string, mode: OverrideMode) => {
    if (!user) return;
    const endpoint = `/api/admin/platform/users/${user.id}/overrides`;
    void runWrite(() =>
      mode === 'inherit'
        ? authFetch(`${endpoint}?capability=${encodeURIComponent(capability)}`, { method: 'DELETE' })
        : authFetch(endpoint, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ capability, effect: mode, reason: 'Updated from permission modal' }),
          }),
    );
  };

  const toolset = useMemo(() => data?.featurePoints.find((p) => p.kind === 'toolset'), [data]);
  const toggleTool = (toolId: string, assigned: boolean) => {
    if (!user || !toolset?.tools) return;
    const current = new Set(toolset.tools.filter((t) => t.assigned).map((t) => t.id));
    if (assigned) current.add(toolId);
    else current.delete(toolId);
    void runWrite(async () => {
      await setUserTools(user.id, [...current]);
      return new Response(null, { status: 200 });
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('permissions.title', { name: user?.nickname ?? '' })}
      size="workspace"
      tabs={
        <div className="flex min-w-max items-center gap-1" role="tablist" aria-label={t('permissions.sections')}>
          {(
            [
              ['basic', t('permissions.basicTab')],
              ['apps', t('permissions.appsTab')],
              ['advanced', t('permissions.advancedTab')],
              ['limits', t('permissions.limitsTab')],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              role="tab"
              id={`permission-tab-${key}`}
              aria-controls={`permission-panel-${key}`}
              aria-selected={tab === key}
              className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
                tab === key
                  ? 'border-primary-500 text-fg font-medium'
                  : 'border-transparent text-fg-muted hover:text-fg-secondary'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      }
    >
      <div
        role="tabpanel"
        id={`permission-panel-${tab}`}
        aria-labelledby={`permission-tab-${tab}`}
        className="min-h-full"
      >
        {loading || !data ? (
          <div className="h-40 flex items-center justify-center">
            <Spinner />
          </div>
        ) : tab === 'limits' ? (
          <LimitsTab userId={data.user.id} limits={data.limits} onSaved={load} />
        ) : (
          <div className="space-y-2.5">
            <p className="text-xs text-fg-muted">
              {tab === 'basic'
                ? t('permissions.basicDescription')
                : tab === 'apps'
                  ? t('permissions.appsDescription')
                  : t('permissions.advancedDescription')}
            </p>
            {data.featurePoints
              .filter((point) => point.group === tab)
              .map((point) => (
                <FeaturePointCard
                  key={point.key}
                  userId={data.user.id}
                  point={point}
                  busy={busy}
                  onSetCapability={setCapability}
                  onToggleMain={toggleMain}
                  onToggleTool={toggleTool}
                  onReload={load}
                />
              ))}
            {tab === 'basic' && <GlobalToolsSection baseline={data.baseline} />}
          </div>
        )}
      </div>
    </Dialog>
  );
}
