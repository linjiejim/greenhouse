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
 *
 * Member spend limits live in Administration › Services & pricing (USD budgets).
 *
 * The view is composed server-side (GET /api/admin/users/:id/access); writes fan out
 * to the existing granular endpoints (features / tools). App capabilities and
 * record/field policies come from the member's role and are shown read-only
 * (per-user overrides were retired in 3.0). Replaces the separate tool-assignment and feature-toggle dialogs and the
 * standalone App Permissions page.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Dialog, Spinner, Tag, Toggle, toast } from '../../components/ui';
import { authFetch } from '../../lib/auth';
import { fetchUserAccess, setUserTools, type UserAccessView, type AccessFeaturePoint } from '../../lib/api/admin';
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

type Tab = 'basic' | 'apps' | 'advanced';

type AccessEntity = NonNullable<AccessFeaturePoint['entities']>[number];
type ReadMode = 'full' | 'masked' | 'none';
type FieldPolicy = { read: ReadMode; write: boolean; export: boolean };

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

/** Read-only record scope + field policy an app entity grants this member through their role. */
function EntityPolicyView({ entity }: { entity: AccessEntity }) {
  const t = useT();
  const fields = entity.effectivePolicy.fields as Record<string, FieldPolicy>;
  return (
    <details className="rounded-lg border border-edge bg-surface-raised">
      <summary className="cursor-pointer list-none px-3 py-2 flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-fg">{entity.title}</span>
        <span className="flex flex-wrap gap-1">
          {entity.effectivePolicy.scopes.length === 0 ? (
            <Tag tone="danger">{t('permissions.denied')}</Tag>
          ) : (
            entity.effectivePolicy.scopes.map((scope) => (
              <Tag key={scope} tone="neutral">
                {t(`permissions.scope.${scope}` as Parameters<typeof t>[0])}
              </Tag>
            ))
          )}
        </span>
      </summary>
      <div className="border-t border-edge p-3">
        <div className="overflow-x-auto rounded-lg border border-edge">
          <table className="w-full min-w-[480px] text-xs">
            <thead className="bg-surface-sunken text-fg-muted">
              <tr>
                <th className="text-left px-2.5 py-1.5">{t('permissions.field')}</th>
                <th className="text-left px-2.5 py-1.5">{t('permissions.read')}</th>
                <th className="text-center px-2.5 py-1.5">{t('permissions.write')}</th>
                <th className="text-center px-2.5 py-1.5">{t('permissions.export')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge">
              {entity.fields.map((field) => {
                const policy = fields[field.id] ?? { read: 'none', write: false, export: false };
                const read: Record<ReadMode, string> = {
                  full: t('permissions.full'),
                  masked: t('permissions.masked'),
                  none: t('permissions.hidden'),
                };
                return (
                  <tr key={field.id}>
                    <td className="px-2.5 py-1.5 font-medium text-fg">{field.title}</td>
                    <td className="px-2.5 py-1.5 text-fg-secondary">{read[policy.read]}</td>
                    <td className="px-2.5 py-1.5 text-center text-fg-secondary">{policy.write ? '✓' : '—'}</td>
                    <td className="px-2.5 py-1.5 text-center text-fg-secondary">{policy.export ? '✓' : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}

// ─── Feature point card ──────────────────────────────────

function FeaturePointCard({
  point,
  busy,
  onToggleMain,
  onToggleTool,
}: {
  point: AccessFeaturePoint;
  busy: boolean;
  onToggleMain: (point: AccessFeaturePoint, next: boolean) => void;
  onToggleTool: (toolId: string, assigned: boolean) => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const isApp = point.kind === 'app';
  const isToolset = point.kind === 'toolset';
  const hasFiner = isApp && ((point.capabilities?.length ?? 0) > 0 || (point.entities?.length ?? 0) > 0);

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
                <div key={cap.capability} className="py-1">
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
                <EntityPolicyView key={`${entity.appId}:${entity.entityId}`} entity={entity} />
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
    }
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
                  point={point}
                  busy={busy}
                  onToggleMain={toggleMain}
                  onToggleTool={toggleTool}
                />
              ))}
            {tab === 'basic' && <GlobalToolsSection baseline={data.baseline} />}
          </div>
        )}
      </div>
    </Dialog>
  );
}
