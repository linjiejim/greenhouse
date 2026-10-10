/**
 * Administration → Bot computers (super only).
 *
 * The organisation configures one Docker host; every member's computer is then
 * created, started, put to sleep and queued automatically (spec §6.3). This
 * page is where an admin sees whether that machinery works and steps in:
 * - Runtime: state, hardened vs development mode, the precheck list with
 *   copyable fix commands, and "Try starting my computer" as an end-to-end test.
 * - Capacity: idle timeout and how many computers may run at once — workspace
 *   settings `bots.computer_idle_minutes` / `bots.computer_max_running`, saved
 *   through the shared admin settings API (Runtime Config shows them too).
 * - Computers: one row per member with state, controller, activity, disk and
 *   memory; Stop and Reset (optionally wiping files and sign-ins).
 *
 * One GET feeds all three sections: the computers table's data source fetches
 * the admin view and lifts the rest into page state.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComputerAdminRow, ComputerState } from '@greenhouse/types/bots';
import { ModulePage } from '../../components/app/module-page';
import { SettingsPanel, SettingsSection } from '../../components/settings';
import { FormActions, FormField, FormGrid } from '../../components/form';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  IconButton,
  Input,
  Skeleton,
  Spinner,
  StatusDot,
  Tag,
  toast,
} from '../../components/ui';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Gauge,
  Play,
  RefreshCw,
  RotateCcw,
  Server,
  Square,
  XCircle,
} from '../../lib/icons';
import { useT, type TranslationKey } from '../../lib/i18n';
import { timeAgo } from '../../lib/utils';
import {
  adminResetComputer,
  adminStopComputer,
  fetchAdminBotComputers,
  saveBotComputerSettings,
  startComputer,
  type AdminBotComputersView,
  type BotComputerCheck,
} from '../../lib/api/bots';
import { reasonKey } from '../../components/bots/computer-phase';
import { ComputerResetDialog } from '../../components/bots/computer-reset-dialog';
import { CrudPage, defineCrud, type CrudDataSource } from '../settings/crud';

const AUTO_REFRESH_MS = 15_000;
export const IDLE_MINUTES_RANGE = { min: 5, max: 240 } as const;
export const MAX_RUNNING_RANGE = { min: 1, max: 50 } as const;

type ComputerRow = ComputerAdminRow & Record<string, unknown>;

export function formatBytes(bytes: number | null): string {
  if (bytes == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** A whole number inside the range, or null. */
export function parseKnob(raw: string, range: { min: number; max: number }): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return value >= range.min && value <= range.max ? value : null;
}

const STATE_COPY: Record<ComputerState, { key: TranslationKey; tone: 'success' | 'info' | 'neutral' | 'danger' }> = {
  running: { key: 'botsComputer.state_running', tone: 'success' },
  starting: { key: 'botsComputer.state_starting', tone: 'info' },
  stopping: { key: 'botsComputer.state_stopping', tone: 'info' },
  absent: { key: 'botsComputer.state_asleep', tone: 'neutral' },
  error: { key: 'botsComputer.state_error', tone: 'danger' },
};

export function BotComputersPanel() {
  const t = useT();
  const [view, setView] = useState<AdminBotComputersView | null>(null);
  const [loadError, setLoadError] = useState(false);
  const reloadRef = useRef<(() => void) | null>(null);
  const [stopTarget, setStopTarget] = useState<ComputerRow | null>(null);
  const [resetTarget, setResetTarget] = useState<ComputerRow | null>(null);
  const [acting, setActing] = useState(false);

  const reload = useCallback(() => reloadRef.current?.(), []);

  // Computers change state on their own (idle sleep, queue, OOM): keep the view fresh while visible.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  const dataSource = useMemo<CrudDataSource<ComputerRow>>(
    () => ({
      async list(params) {
        try {
          const next = await fetchAdminBotComputers();
          setView(next);
          setLoadError(false);
          const skip = params.skip ?? 0;
          return {
            items: next.computers.slice(skip, skip + (params.limit ?? 50)) as ComputerRow[],
            total: next.computers.length,
          };
        } catch (err) {
          setLoadError(true);
          throw err;
        }
      },
    }),
    [],
  );

  const stop = async () => {
    if (!stopTarget) return;
    setActing(true);
    try {
      await adminStopComputer(stopTarget.user_id);
      toast(t('botsAdmin.stopped'), 'success');
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('botsAdmin.actionFailed'), 'error');
    } finally {
      setActing(false);
      setStopTarget(null);
    }
  };

  const reset = async (wipeData: boolean) => {
    if (!resetTarget) return;
    setActing(true);
    try {
      await adminResetComputer(resetTarget.user_id, wipeData);
      toast(t('botsComputer.resetDone'), 'success');
      setResetTarget(null);
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('botsAdmin.actionFailed'), 'error');
    } finally {
      setActing(false);
    }
  };

  const schema = useMemo(
    () =>
      defineCrud<ComputerRow>({
        name: t('botsAdmin.computerEntity'),
        testId: 'bot-computers',
        dataSource,
        idField: 'user_id',
        icon: Server,
        columns: [
          {
            key: 'nickname',
            label: t('botsAdmin.col_member'),
            type: 'custom',
            render: (row) => (
              <span className="block max-w-[200px] truncate text-sm text-fg" title={row.nickname}>
                {row.nickname}
              </span>
            ),
          },
          {
            key: 'state',
            label: t('botsAdmin.col_state'),
            type: 'custom',
            render: (row) => {
              const copy = STATE_COPY[row.state];
              const why = reasonKey(row.state_reason);
              return (
                <Tag tone={copy?.tone ?? 'neutral'} title={why ? t(why) : (row.state_reason ?? undefined)}>
                  {copy ? t(copy.key) : row.state}
                </Tag>
              );
            },
          },
          {
            key: 'controller',
            label: t('botsAdmin.col_controller'),
            type: 'custom',
            responsiveHide: 'md',
            render: (row) => (
              <span className="text-xs text-fg-secondary">
                {row.controller === 'user' ? t('botsAdmin.controller_user') : t('botsAdmin.controller_bot')}
              </span>
            ),
          },
          {
            key: 'last_active_at',
            label: t('botsAdmin.col_lastActive'),
            type: 'custom',
            render: (row) => (
              <span className="whitespace-nowrap text-xs text-fg-muted">
                {row.last_active_at ? timeAgo(row.last_active_at) : '—'}
              </span>
            ),
          },
          {
            key: 'disk_bytes',
            label: t('botsAdmin.col_disk'),
            type: 'custom',
            align: 'right',
            responsiveHide: 'sm',
            render: (row) => <span className="font-mono text-xs text-fg-muted">{formatBytes(row.disk_bytes)}</span>,
          },
          {
            key: 'memory_bytes',
            label: t('botsAdmin.col_memory'),
            type: 'custom',
            align: 'right',
            responsiveHide: 'sm',
            render: (row) => <span className="font-mono text-xs text-fg-muted">{formatBytes(row.memory_bytes)}</span>,
          },
        ],
        tableActions: [
          {
            key: 'stop',
            label: t('botsAdmin.stop'),
            icon: Square,
            tone: 'warning',
            visible: (row) => row.state === 'running' || row.state === 'starting',
            onClick: (row) => setStopTarget(row),
          },
          {
            key: 'reset',
            label: t('botsAdmin.reset'),
            icon: RotateCcw,
            tone: 'danger',
            onClick: (row) => setResetTarget(row),
          },
        ],
        slots: {
          toolbar: (ctx) => {
            // The page's refresh, auto-refresh and post-save reload all go through the table's loader.
            reloadRef.current = ctx.reload;
            return (
              <div className="flex items-center gap-2">
                <Server size={14} className="text-primary-fg" aria-hidden="true" />
                <h2 className="text-sm font-semibold text-fg">{t('botsAdmin.computersTitle')}</h2>
                <span className="text-xs text-fg-muted">{t('botsAdmin.computerCount', { count: ctx.total })}</span>
              </div>
            );
          },
          empty: (
            <EmptyState
              variant="compact"
              icon={Server}
              title={t('botsAdmin.emptyTitle')}
              description={t('botsAdmin.emptyDesc')}
            />
          ),
        },
      }),
    [t, dataSource],
  );

  const running = view?.computers.filter((c) => c.state === 'running' || c.state === 'starting').length ?? 0;

  return (
    <ModulePage
      moduleId="admin.bot-computers"
      layout="list"
      actions={
        <Button size="sm" variant="outline" onClick={reload} data-testid="bot-computers-refresh">
          <RefreshCw size={14} className="mr-1" aria-hidden="true" />
          {t('botsAdmin.refresh')}
        </Button>
      }
    >
      <SettingsPanel>
        {view ? (
          <>
            <RuntimeSection view={view} onChanged={reload} />
            <CapacitySection
              settings={view.settings}
              running={running}
              hosted={view.runtime.driver === 'e2b'}
              onSaved={reload}
            />
          </>
        ) : loadError ? (
          <EmptyState
            tone="danger"
            icon={AlertTriangle}
            title={t('botsAdmin.loadFailed')}
            action={
              <Button size="sm" variant="outline" onClick={reload}>
                {t('botsComputer.retry')}
              </Button>
            }
          />
        ) : (
          <div className="space-y-4" role="status" aria-label={t('common.loading')}>
            <Skeleton className="h-40 w-full rounded-xl" />
            <Skeleton className="h-28 w-full rounded-xl" />
          </div>
        )}
        <CrudPage schema={schema} />
      </SettingsPanel>

      <ConfirmDialog
        open={stopTarget !== null}
        onClose={() => setStopTarget(null)}
        onConfirm={() => void stop()}
        title={t('botsAdmin.stopTitle', { name: stopTarget?.nickname ?? '' })}
        description={t('botsAdmin.stopDesc')}
        confirmLabel={t('botsAdmin.stop')}
        confirmVariant="destructive"
      />
      <ComputerResetDialog
        open={resetTarget !== null}
        title={t('botsAdmin.resetTitleFor', { name: resetTarget?.nickname ?? '' })}
        busy={acting}
        onClose={() => setResetTarget(null)}
        onConfirm={(wipe) => void reset(wipe)}
      />
    </ModulePage>
  );
}

// ─── Runtime + checks ────────────────────────────────────

const RUNTIME_COPY: Record<
  AdminBotComputersView['runtime']['state'],
  { key: TranslationKey; dot: 'success' | 'danger' | 'muted' | 'info' }
> = {
  ready: { key: 'botsAdmin.runtime_ready', dot: 'success' },
  unavailable: { key: 'botsAdmin.runtime_unavailable', dot: 'danger' },
  disabled: { key: 'botsAdmin.runtime_disabled', dot: 'muted' },
  checking: { key: 'botsAdmin.runtime_checking', dot: 'info' },
};

function RuntimeSection({ view, onChanged }: { view: AdminBotComputersView; onChanged: () => void }) {
  const t = useT();
  const [trying, setTrying] = useState(false);
  const { runtime, checks } = view;
  const copy = RUNTIME_COPY[runtime.state];
  const why = reasonKey(runtime.reason);
  const failing = checks.filter((check) => !check.ok).length;

  const tryStart = async () => {
    setTrying(true);
    try {
      const status = await startComputer();
      if (status.state === 'running') toast(t('botsAdmin.tryStartOk'), 'success');
      else if (status.queue_position != null) toast(t('botsAdmin.tryStartQueued'), 'info');
      else toast(t('botsAdmin.tryStartFailed'), 'error');
    } catch (err) {
      toast(err instanceof Error ? err.message : t('botsAdmin.tryStartFailed'), 'error');
    } finally {
      setTrying(false);
      onChanged();
    }
  };

  return (
    <SettingsSection
      title={t('botsAdmin.runtimeTitle')}
      description={t(runtime.driver === 'e2b' ? 'botsAdmin.runtimeDescHosted' : 'botsAdmin.runtimeDesc')}
      icon={Server}
      action={
        <Button
          size="sm"
          variant="outline"
          onClick={() => void tryStart()}
          disabled={trying || runtime.state === 'disabled'}
          data-testid="bot-computers-try-start"
        >
          {trying ? <Spinner className="mr-1" /> : <Play size={14} className="mr-1" aria-hidden="true" />}
          {t('botsAdmin.tryStart')}
        </Button>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2" data-testid="bot-computers-runtime">
          <StatusDot color={copy.dot} pulse={runtime.state === 'checking'} />
          <span className="text-sm font-medium text-fg">{t(copy.key)}</span>
          {runtime.state === 'ready' && (
            <Tag tone={runtime.hardened ? 'success' : 'warning'}>
              {runtime.driver === 'e2b'
                ? t('botsAdmin.hostedBadge')
                : runtime.hardened
                  ? t('botsAdmin.hardened')
                  : t('botsAdmin.devMode')}
            </Tag>
          )}
          {runtime.reason && (
            <span className="text-xs text-fg-muted">
              {why ? t(why) : <code className="font-mono text-[11px]">{runtime.reason}</code>}
            </span>
          )}
        </div>
        {runtime.state === 'ready' && !runtime.hardened && (
          <p className="rounded-lg border border-warning bg-warning-subtle px-3 py-2 text-xs leading-5 text-fg-secondary">
            {t('botsAdmin.devModeDesc')}
          </p>
        )}
        <div>
          <p className="mb-1.5 text-xs font-medium text-fg-secondary">
            {failing > 0 ? t('botsAdmin.checksFailing', { count: failing }) : t('botsAdmin.checksTitle')}
          </p>
          {checks.length === 0 ? (
            <p className="text-xs text-fg-faint">{t('botsAdmin.noChecks')}</p>
          ) : (
            <ul className="divide-y divide-edge rounded-lg border border-edge" data-testid="bot-computers-checks">
              {checks.map((check) => (
                <CheckRow key={check.id} check={check} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}

// Precheck ids from the API (apps/api/src/bots/computer/runtime.ts); an id
// this list lacks still renders, under its raw id.
const CHECK_KEYS: Record<string, TranslationKey> = {
  config: 'botsAdmin.check_config',
  docker: 'botsAdmin.check_docker',
  runtime: 'botsAdmin.check_runtime',
  image: 'botsAdmin.check_image',
  image_fresh: 'botsAdmin.check_image_fresh',
  network: 'botsAdmin.check_network',
  egress: 'botsAdmin.check_egress',
  capacity: 'botsAdmin.check_capacity',
  host_disk: 'botsAdmin.check_host_disk',
  provider: 'botsAdmin.check_provider',
  template: 'botsAdmin.check_template',
};

function CheckRow({ check }: { check: BotComputerCheck }) {
  const t = useT();
  const titleKey = CHECK_KEYS[check.id];
  const copyFix = async () => {
    if (!check.fix) return;
    try {
      await navigator.clipboard.writeText(check.fix);
      toast(t('botsAdmin.commandCopied'), 'success');
    } catch {
      toast(t('common.copyFailed'), 'error');
    }
  };
  return (
    <li className="flex items-start gap-2.5 px-3 py-2.5" data-check={check.id} data-ok={check.ok ? 'true' : 'false'}>
      {check.ok ? (
        <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0 text-success" aria-label={t('botsAdmin.checkOk')} />
      ) : (
        <XCircle size={16} className="mt-0.5 flex-shrink-0 text-danger" aria-label={t('botsAdmin.checkFailed')} />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-fg">
          {titleKey ? t(titleKey) : <code className="font-mono">{check.id}</code>}
        </p>
        <p className="mt-0.5 whitespace-pre-line text-xs leading-5 text-fg-muted">{check.detail}</p>
        {!check.ok && check.fix && (
          // A fix can be a multi-line script (egress lockdown): shown whole, wrapped, and copied whole.
          <div className="mt-1.5 flex items-start gap-1 rounded-md border border-edge bg-surface-sunken py-1 pl-2 pr-1">
            <code
              className="min-w-0 flex-1 whitespace-pre-wrap break-all py-0.5 font-mono text-[11px] text-fg-secondary"
              data-testid="bot-computers-fix"
            >
              {check.fix}
            </code>
            <IconButton label={t('botsAdmin.copyCommand')} size="compact" tooltip="top" onClick={() => void copyFix()}>
              <Copy size={12} />
            </IconButton>
          </div>
        )}
      </div>
    </li>
  );
}

// ─── Capacity knobs ──────────────────────────────────────

function CapacitySection({
  settings,
  running,
  hosted,
  onSaved,
}: {
  settings: AdminBotComputersView['settings'];
  running: number;
  /** Hosted sandboxes sleep (pause) instead of being removed, and the provider plan caps concurrency. */
  hosted: boolean;
  onSaved: () => void;
}) {
  const t = useT();
  const [idle, setIdle] = useState(String(settings.idle_minutes));
  const [max, setMax] = useState(String(settings.max_running));
  const [saving, setSaving] = useState(false);

  // Follow the server after a save or another admin's edit, unless this admin is mid-edit.
  const dirty = idle !== String(settings.idle_minutes) || max !== String(settings.max_running);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (dirtyRef.current) return;
    setIdle(String(settings.idle_minutes));
    setMax(String(settings.max_running));
  }, [settings.idle_minutes, settings.max_running]);

  const idleValue = parseKnob(idle, IDLE_MINUTES_RANGE);
  const maxValue = parseKnob(max, MAX_RUNNING_RANGE);

  const save = async () => {
    if (idleValue == null || maxValue == null) return;
    setSaving(true);
    try {
      await saveBotComputerSettings({
        ...(idleValue !== settings.idle_minutes ? { idle_minutes: idleValue } : {}),
        ...(maxValue !== settings.max_running ? { max_running: maxValue } : {}),
      });
      toast(t('botsAdmin.settingsSaved'), 'success');
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('botsAdmin.actionFailed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      title={t('botsAdmin.capacityTitle')}
      description={t('botsAdmin.runningSummary', { running, max: settings.max_running })}
      icon={Gauge}
    >
      <FormGrid>
        <FormField
          label={t('botsAdmin.idleMinutes')}
          help={t(hosted ? 'botsAdmin.idleMinutesHelpHosted' : 'botsAdmin.idleMinutesHelp')}
          error={idleValue == null ? t('botsAdmin.err_idleRange') : undefined}
        >
          <Input
            inputMode="numeric"
            value={idle}
            onChange={(event) => setIdle(event.target.value)}
            data-testid="bot-computers-idle"
          />
        </FormField>
        <FormField
          label={t('botsAdmin.maxRunning')}
          help={t(hosted ? 'botsAdmin.maxRunningHelpHosted' : 'botsAdmin.maxRunningHelp')}
          error={maxValue == null ? t('botsAdmin.err_maxRange') : undefined}
        >
          <Input
            inputMode="numeric"
            value={max}
            onChange={(event) => setMax(event.target.value)}
            data-testid="bot-computers-max"
          />
        </FormField>
      </FormGrid>
      <FormActions>
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={!dirty || saving || idleValue == null || maxValue == null}
          data-testid="bot-computers-save"
        >
          {saving && <Spinner className="mr-1" />}
          {t('botsAdmin.saveSettings')}
        </Button>
      </FormActions>
    </SettingsSection>
  );
}
