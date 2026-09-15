/** Desktop preference sections shared by Settings and the native app-menu dialog. */

import type { Profile } from '@greenhouse/types/api';
import React, { useCallback, useEffect, useState } from 'react';
import { Button, Card, Dialog, Input, Spinner, StatusDot, Tabs, Toggle, toast } from '../../components/ui';
import { Bot, Check, Keyboard, MessageSquareQuote, RefreshCw, Search } from '../../lib/icons';
import { invokeDesktop } from '../../lib/desktop/bridge';
import { getCapabilities, requestPermission } from '../../lib/desktop/capabilities';
import {
  getDesktopSurfacePreferences,
  setDesktopSurfacePreferences,
  subscribeDesktopSurfacePreferences,
  type DesktopSurfacePreferences,
} from '../../lib/desktop/surface-preferences';
import type { DesktopCapabilities, DesktopSettings, ShortcutId } from '../../lib/desktop/types';
import { shouldReconcileSelectionWatcher } from '../../lib/desktop/watcher-reconciliation';
import { useAuthStore } from '../../stores/auth-store';
import { useProfileStore } from '../../stores/profile-store';
import { useUIStore } from '../../stores/ui-store';
import { useLocalized, useT, type TranslationKey } from '../../lib/i18n';

const PENDING_SELECTION_ENABLE_KEY = 'greenhouse:desktop-selection-enable-pending';

const SHORTCUT_KEYS: Record<ShortcutId, { label: TranslationKey; hint: TranslationKey }> = {
  focus_main: { label: 'desktop.shortcutFocusMain', hint: 'desktop.shortcutFocusMainHint' },
  quick_capture: { label: 'desktop.shortcutQuickCapture', hint: 'desktop.shortcutQuickCaptureHint' },
  screenshot: { label: 'desktop.shortcutScreenshot', hint: 'desktop.shortcutScreenshotHint' },
  selection: { label: 'desktop.shortcutSelection', hint: 'desktop.shortcutSelectionHint' },
};

export function DesktopPreferencesDialog() {
  const open = useUIStore((state) => state.desktopPreferencesOpen);
  const setOpen = useUIStore((state) => state.setDesktopPreferencesOpen);
  const [tab, setTab] = useState('launchers');
  const t = useT();

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title={t('desktop.preferencesTitle')}
      size="lg"
      tabs={
        <Tabs
          tabs={[
            { key: 'launchers', label: t('desktop.tabLaunchers') },
            { key: 'shortcuts', label: t('desktop.globalShortcuts') },
          ]}
          active={tab}
          onChange={setTab}
        />
      }
    >
      {tab === 'launchers' ? (
        <div className="space-y-6">
          <DesktopSelectionWatcherSection />
          <DesktopSurfaceProfilesSection />
        </div>
      ) : (
        <DesktopShortcutsSection />
      )}
    </Dialog>
  );
}

/** Backwards-compatible aggregate for call sites that want the compact dialog body. */
export function DesktopPreferencesControls() {
  return (
    <div className="space-y-6">
      <DesktopSelectionWatcherSection />
      <DesktopSurfaceProfilesSection />
      <DesktopShortcutsSection />
    </div>
  );
}

export function DesktopShortcutsSection() {
  const t = useT();
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => setSettings(await invokeDesktop('desktop_get_settings')), []);
  useEffect(() => {
    void reload().catch((error) => toast(String(error), 'error'));
  }, [reload]);

  if (!settings) return <Loading label={t('desktop.loadingShortcuts')} />;

  return (
    <section>
      <SectionHeader icon={<Keyboard size={16} />} title={t('desktop.globalShortcuts')}>
        {t('desktop.globalShortcutsHint')}
      </SectionHeader>
      <Card className="divide-y divide-edge p-0">
        {(Object.keys(SHORTCUT_KEYS) as ShortcutId[]).map((id) => (
          <div key={id} className="flex flex-wrap items-center gap-3 p-4">
            <div className="min-w-48 flex-1">
              <div className="text-sm text-fg">{t(SHORTCUT_KEYS[id].label)}</div>
              <div className="text-xs text-fg-faint">{t(SHORTCUT_KEYS[id].hint)}</div>
            </div>
            <ShortcutInput
              value={settings.shortcuts[id] ?? ''}
              disabled={busy != null}
              onCommit={async (accelerator) => {
                setBusy(id);
                try {
                  const next = await invokeDesktop('desktop_set_shortcuts', {
                    shortcutsMap: { ...settings.shortcuts, [id]: accelerator },
                  });
                  setSettings(next);
                  toast(t('desktop.shortcutUpdated'), 'success');
                } catch (error) {
                  toast(error instanceof Error ? error.message : String(error), 'error');
                } finally {
                  setBusy(null);
                }
              }}
            />
          </div>
        ))}
      </Card>
    </section>
  );
}

export function DesktopSelectionWatcherSection() {
  const t = useT();
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [caps, setCaps] = useState<DesktopCapabilities | null>(null);
  const [pendingEnable, setPendingEnable] = useState(() => readPendingEnable());
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async (reconcile = true) => {
    let [nextSettings, nextCaps] = await Promise.all([
      invokeDesktop('desktop_get_settings'),
      getCapabilities({ refresh: true }),
    ]);
    if (reconcile && shouldReconcileSelectionWatcher(nextSettings, nextCaps, readPendingEnable())) {
      await invokeDesktop('desktop_set_selection_watch', { enabled: true });
      writePendingEnable(false);
      [nextSettings, nextCaps] = await Promise.all([
        invokeDesktop('desktop_get_settings'),
        getCapabilities({ refresh: true }),
      ]);
    }
    setPendingEnable(readPendingEnable());
    setSettings(nextSettings);
    setCaps(nextCaps);
  }, []);

  useEffect(() => {
    const refresh = () => void reload().catch((error) => toast(String(error), 'error'));
    refresh();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [reload]);

  if (!settings || !caps) return <Loading label={t('desktop.loadingSelectionState')} />;
  const configured = settings.selectionWatch || pendingEnable;
  const running = caps.selectionWatch;

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      if (!enabled) {
        writePendingEnable(false);
        setPendingEnable(false);
        await invokeDesktop('desktop_set_selection_watch', { enabled: false });
      } else if (caps.selection.state === 'needs_permission') {
        writePendingEnable(true);
        setPendingEnable(true);
        await requestPermission(caps.selection.permission);
        toast(t('desktop.openedSystemSettings'), 'info');
      } else {
        await invokeDesktop('desktop_set_selection_watch', { enabled: true });
        writePendingEnable(false);
        setPendingEnable(false);
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
      await reload().catch(() => {});
    }
  };

  return (
    <section>
      <SectionHeader icon={<MessageSquareQuote size={16} />} title={t('desktop.selectionPopover')}>
        {t('desktop.selectionPopoverHint')}
      </SectionHeader>
      <Card className="divide-y divide-edge p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="min-w-0 flex-1">
            <div className="text-sm text-fg">{t('desktop.showSelectionPopover')}</div>
            <div className="text-xs text-fg-faint">{t('desktop.selectionWatchDisableHint')}</div>
          </div>
          <Toggle
            checked={configured}
            disabled={caps.selection.state === 'unsupported' || busy}
            onChange={(enabled) => void toggle(enabled)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 p-4 text-xs">
          <StatusLabel
            label={t('desktop.statusConfigured')}
            success={configured}
            successText={t('desktop.statusEnabled')}
            idleText={t('desktop.statusDisabled')}
          />
          <StatusLabel
            label={t('desktop.statusRunning')}
            success={running}
            successText={t('desktop.statusListening')}
            idleText={t('desktop.statusNotRunning')}
          />
          {pendingEnable && !running && <span className="text-warning-fg">{t('desktop.awaitingPermission')}</span>}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={busy}
            onClick={() => void reload().catch((error) => toast(String(error), 'error'))}
          >
            <RefreshCw size={13} />
            <span className="ml-1">{t('desktop.recheck')}</span>
          </Button>
        </div>
      </Card>
    </section>
  );
}

export function DesktopSurfaceProfilesSection() {
  const localized = useLocalized();
  const t = useT();
  const userId = useAuthStore((state) => state.currentUser?.id);
  const profiles = useProfileStore((state) => state.profiles);
  const loading = useProfileStore((state) => state.loading);
  const fetchProfiles = useProfileStore((state) => state.fetchProfiles);
  const [preferences, setPreferences] = useState<DesktopSurfacePreferences>(() => getDesktopSurfacePreferences(userId));

  useEffect(() => {
    void fetchProfiles();
    setPreferences(getDesktopSurfacePreferences(userId));
    return subscribeDesktopSurfacePreferences(userId, setPreferences);
  }, [fetchProfiles, userId]);

  const update = (key: 'selectionProfileIds' | 'quickProfileIds', profileId: string, enabled: boolean) => {
    const current = preferences[key];
    const nextIds = enabled ? [...current, profileId] : current.filter((id) => id !== profileId);
    setPreferences(setDesktopSurfacePreferences(userId, { ...preferences, [key]: nextIds }));
  };

  if (loading && profiles.length === 0) return <Loading label={t('desktop.loadingAgents')} />;

  return (
    <div className="space-y-6">
      <ProfileOptions
        icon={<Search size={16} />}
        title={t('desktop.quickLauncher')}
        detail={t('desktop.quickLauncherDetail')}
        profiles={profiles}
        selected={preferences.quickProfileIds}
        localized={localized}
        t={t}
        onToggle={(id, enabled) => update('quickProfileIds', id, enabled)}
      />
      <ProfileOptions
        icon={<Bot size={16} />}
        title={t('desktop.selectionAgents')}
        detail={t('desktop.selectionAgentsDetail')}
        profiles={profiles}
        selected={preferences.selectionProfileIds}
        localized={localized}
        t={t}
        onToggle={(id, enabled) => update('selectionProfileIds', id, enabled)}
      />
    </div>
  );
}

function ProfileOptions({
  icon,
  title,
  detail,
  profiles,
  selected,
  localized,
  t,
  onToggle,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  profiles: Profile[];
  selected: string[];
  localized: ReturnType<typeof useLocalized>;
  t: ReturnType<typeof useT>;
  onToggle: (id: string, enabled: boolean) => void;
}) {
  return (
    <section>
      <SectionHeader icon={icon} title={title}>
        {detail}
      </SectionHeader>
      <Card className="divide-y divide-edge p-0">
        {profiles.length === 0 ? (
          <div className="p-4 text-sm text-fg-faint">{t('desktop.noAgents')}</div>
        ) : (
          profiles.map((profile) => {
            const enabled = selected.includes(profile.id);
            return (
              <div key={profile.id} className="flex items-center gap-3 p-4 hover:bg-surface-muted/50">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-subtle text-primary-fg">
                  <Bot size={15} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-fg">{localized(profile.name_i18n, profile.name)}</span>
                  {profile.description && (
                    <span className="block truncate text-xs text-fg-faint">{profile.description}</span>
                  )}
                </span>
                <Toggle checked={enabled} onChange={(next) => onToggle(profile.id, next)} />
              </div>
            );
          })
        )}
      </Card>
    </section>
  );
}

function StatusLabel({
  label,
  success,
  successText,
  idleText,
}: {
  label: string;
  success: boolean;
  successText: string;
  idleText: string;
}) {
  return (
    <span className="flex items-center gap-1.5 text-fg-muted">
      <StatusDot color={success ? 'success' : 'warning'} />
      {label}：{success ? successText : idleText}
      {success && <Check size={12} />}
    </span>
  );
}

function SectionHeader({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-fg">
        <span className="text-fg-muted">{icon}</span>
        {title}
      </div>
      {children && <p className="mt-1 text-xs text-fg-faint">{children}</p>}
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-fg-faint">
      <Spinner />
      {label}
    </div>
  );
}

function ShortcutInput({
  value,
  disabled,
  onCommit,
}: {
  value: string;
  disabled: boolean;
  onCommit: (accelerator: string) => void;
}) {
  const t = useT();
  const [recording, setRecording] = useState(false);
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    if (event.key === 'Escape') return setRecording(false);
    const parts: string[] = [];
    if (event.metaKey || event.ctrlKey) parts.push('CmdOrCtrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    const key = normalizeKey(event.key, event.code);
    if (!key || parts.length === 0) return;
    parts.push(key);
    setRecording(false);
    onCommit(parts.join('+'));
  };
  return (
    <div className="w-56 max-w-full">
      <Input
        readOnly
        size="sm"
        disabled={disabled}
        value={recording ? t('desktop.pressShortcut') : value}
        onFocus={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={onKeyDown}
        className={`font-mono ${recording ? 'border-primary-400 bg-primary-subtle text-primary-fg-strong' : 'text-fg-secondary'}`}
        title={t('desktop.shortcutInputHint')}
      />
    </div>
  );
}

function normalizeKey(key: string, code: string): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Dead'].includes(key)) return null;
  if (key === ' ') return 'Space';
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function readPendingEnable(): boolean {
  try {
    return localStorage.getItem(PENDING_SELECTION_ENABLE_KEY) === '1';
  } catch {
    return false;
  }
}

function writePendingEnable(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(PENDING_SELECTION_ENABLE_KEY, '1');
    else localStorage.removeItem(PENDING_SELECTION_ENABLE_KEY);
  } catch {
    /* ignore restricted storage */
  }
}
