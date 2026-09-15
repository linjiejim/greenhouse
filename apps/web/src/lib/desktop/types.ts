/**
 * Native command contract — the TypeScript mirror of the Rust command surface in
 * `apps/desktop/src-tauri/src/commands/`.
 *
 * This file and the Rust side change together. The wire shapes below are pinned by
 * `bundle::tests::active_bundle_serializes_to_the_shape_typescript_expects`, so a
 * rename on either side fails a test rather than silently producing `undefined`.
 *
 * The same web bundle runs in a plain browser, so nothing here may be imported at
 * module scope by code that also runs there — go through `bridge.ts`, which
 * feature-detects and lazy-loads the Tauri API.
 */

// ─── Hot-update state ────────────────────────────────────

/** Why the shell is running the embedded baseline instead of a hot-update bundle. */
export type BaselineReason = 'no_pointer' | 'pointer_unreadable' | 'bundle_missing' | 'rolled_back_after_failed_boot';

export type ActiveBundle =
  | { kind: 'baseline'; reason: BaselineReason; rolledBackFrom: string | null }
  | { kind: 'staged'; version: string; dir: string };

export interface DesktopInfo {
  /** Installed app's user-facing version, sourced from root package.json. */
  shellVersion: string;
  /** Web bundle version currently loaded (baseline or staged). */
  webBundleVersion: string;
  activeBundle: ActiveBundle;
  /** Rust `std::env::consts::OS`: 'macos' | 'windows' | 'linux' | … */
  platform: string;
  /** Rust `std::env::consts::ARCH`: 'aarch64' | 'x86_64' | … */
  arch: string;
}

export interface WebReleaseNotes {
  schemaVersion: 1;
  /** User-facing product version from the repository root. */
  appVersion: string;
  /** Internal monotonic Web Bundle version. */
  webBundleVersion: string;
  title: string;
  summary: string;
  changes: string[];
  releasedAt: string;
}

// ─── Capabilities & permissions ──────────────────────────

export type Permission = 'accessibility' | 'screen_recording';

/**
 * `needs_permission` is user-actionable; `unsupported` never will be. The UI says
 * different things for each, which is why they're distinct states rather than a
 * boolean.
 */
export type Availability =
  | { state: 'available' }
  | { state: 'needs_permission'; permission: Permission }
  | { state: 'unsupported'; reason: string };

export interface PermissionStatus {
  accessibility: boolean;
  screenRecording: boolean;
  /** False where these grants don't exist (Windows/Linux) — hide the whole section. */
  applicable: boolean;
}

export interface DesktopCapabilities {
  capture: Availability;
  selection: Availability;
  clipboard: Availability;
  permissions: PermissionStatus;
  selectionWatch: boolean;
  /** macOS can drag out a region; elsewhere every mode captures the full screen. */
  interactiveCapture: boolean;
}

// ─── Capture ─────────────────────────────────────────────

export type CaptureMode = 'interactive' | 'window' | 'full';

export interface Capture {
  mime: string;
  /** Raw base64, no data-URL prefix. */
  base64: string;
  width: number;
  height: number;
}

// ─── Selection ───────────────────────────────────────────

export type SelectionSource = 'accessibility' | 'clipboard';

export interface Selection {
  text: string;
  source: SelectionSource;
  /** Screen coordinates to anchor a floating bar to; null for hotkey-driven reads. */
  x: number | null;
  y: number | null;
}

export type SelectionSurfaceMode = 'icon' | 'profiles' | 'composer';

// ─── Shortcuts ───────────────────────────────────────────

export type ShortcutId = 'focus_main' | 'quick_capture' | 'screenshot' | 'selection';

/** Accelerator per shortcut id, e.g. `{ screenshot: 'CmdOrCtrl+Shift+2' }`. */
export type ShortcutMap = Partial<Record<ShortcutId, string>>;

// ─── Settings ────────────────────────────────────────────

/**
 * What the settings UI renders. Note this is the shell's *view*, not what it
 * persists: `apiBaseUrl` is the base actually in use after the release-build lock.
 */
export interface DesktopSettings {
  apiBaseUrl: string;
  /**
   * True only when a packaged build had its server baked in at build time — then
   * the UI must not offer to change it. A build without a baked-in server keeps
   * the server as a setting in every build, packaged or not, so the settings page
   * keys off this flag rather than off "is this a dev build".
   */
  apiBaseLocked: boolean;
  /** Resolved accelerators, i.e. what is actually registered. */
  shortcuts: Required<ShortcutMap>;
  /** Always-on selection watcher. Opt-in — it observes every click. */
  selectionWatch: boolean;
}

// ─── Tray menu ───────────────────────────────────────────

/**
 * Content model for the native tray dropdown. The web layer owns everything in
 * it — labels (localized), the Agent list and the recent sessions with their
 * running state — so the menu stays hot-updatable; the shell only renders it.
 * Wire shape pinned by `tray::tests::tray_menu_model_deserializes_…`.
 */
export interface TrayMenuModel {
  labels: {
    open: string;
    newChat: string;
    profiles: string;
    sessions: string;
    settings: string;
    quit: string;
  };
  /**
   * Accelerator shown beside "Open Greenhouse", right-aligned and dimmed by
   * AppKit. Carries the user's *configured* `focus_main` binding, so rebinding
   * the shortcut updates the menu without a shell release.
   */
  openAccelerator: string | null;
  profiles: Array<{ id: string; label: string }>;
  sessions: Array<{ id: string; label: string; running: boolean }>;
}

/**
 * A tray menu click, routed back to the main window. Open/Quit never appear
 * here — they stay native so the tray works even when the webview is wedged.
 */
export type TrayAction =
  | { kind: 'newChat' }
  | { kind: 'settings' }
  | { kind: 'profile'; id: string }
  | { kind: 'session'; id: string };

export type WebUpdateResult =
  | {
      status: 'staged';
      version: string;
      /** Optional for compatibility with shells released before update notes. */
      releaseNotes?: WebReleaseNotes | null;
      /** False when the same pending bundle was already downloaded. */
      downloaded?: boolean;
    }
  | { status: 'up_to_date' }
  | { status: 'needs_newer_shell'; required: string };

export type ShellUpdateResult =
  | { status: 'installed'; version: string }
  /** The feed has nothing newer yet — e.g. the shell release is still publishing. */
  | { status: 'up_to_date' };

/** `ready` = downloaded and verified, so installing it is now a local file swap. */
export type ShellUpdatePreparation = { status: 'ready'; version: string } | { status: 'up_to_date' };

/** Where a manually downloaded installer ended up. */
export interface DownloadedInstaller {
  /** Absolute path of the saved installer (.dmg / -setup.exe), already revealed in the file manager. */
  path: string;
  version: string;
}

/** Payload of `DESKTOP_EVENT.installerProgress`, in bytes. */
export interface InstallerProgress {
  received: number;
  total: number;
}

// ─── Command map ─────────────────────────────────────────

/**
 * Every native command, mapped to its argument and return types.
 *
 * Keeping this as one map (rather than a function per command) is what lets
 * `invokeDesktop` be typed generically, and makes the whole native surface
 * reviewable in one screen.
 */
export interface DesktopCommands {
  desktop_capabilities: { args: void; result: DesktopCapabilities };
  /** `null` means the user cancelled — not an error. */
  desktop_capture_screen: { args: { mode: CaptureMode }; result: Capture | null };
  desktop_check_web_update: { args: void; result: WebUpdateResult };
  /**
   * Download the installer published for this platform into Downloads and reveal
   * it. Takes no URL — the shell reads the release index itself, so this stays a
   * named capability rather than a "fetch anything" hatch.
   */
  desktop_download_shell_installer: { args: void; result: DownloadedInstaller };
  desktop_get_settings: { args: void; result: DesktopSettings };
  desktop_info: { args: void; result: DesktopInfo };
  /**
   * Install a newer shell over the current .app; restart to apply. Normally
   * instant, because the background pass below already downloaded it.
   */
  desktop_install_shell_update: { args: void; result: ShellUpdateResult };
  /**
   * Check for a newer shell and download it *without installing* — the app-line
   * counterpart to `desktop_check_web_update`, run on the same schedule.
   */
  desktop_prepare_shell_update: { args: void; result: ShellUpdatePreparation };
  desktop_log: { args: { level: 'debug' | 'info' | 'warn' | 'error'; message: string }; result: null };
  desktop_mark_boot_ok: { args: void; result: null };
  desktop_read_clipboard: { args: void; result: string | null };
  /** `null` means nothing is selected, or the focused app doesn't expose it. */
  desktop_read_selection: { args: void; result: Selection | null };
  desktop_request_permission: { args: { permission: Permission }; result: PermissionStatus };
  desktop_reveal_in_file_manager: { args: { path: string }; result: null };
  desktop_restart: { args: void; result: null };
  /** Rejected in packaged builds, where the server is fixed. */
  desktop_set_api_base: { args: { url: string }; result: DesktopSettings };
  desktop_set_selection_watch: { args: { enabled: boolean }; result: boolean };
  /** Replace the tray dropdown with a web-owned content model. */
  desktop_set_tray_menu: { args: { model: TrayMenuModel }; result: null };
  desktop_write_clipboard: { args: { text: string }; result: null };
  desktop_focus_main_window: { args: void; result: null };
  desktop_hide_quick_window: { args: void; result: null };
  desktop_hide_selection_bar: { args: void; result: null };
  desktop_set_selection_surface_mode: { args: { mode: SelectionSurfaceMode }; result: null };
  desktop_show_selection_bar: { args: { x: number; y: number }; result: null };
  desktop_set_shortcuts: { args: { shortcutsMap: ShortcutMap }; result: DesktopSettings };
  /** Consumed on read — a selection is handed to whichever window asks first. */
  desktop_take_pending_selection: { args: void; result: Selection | null };
  desktop_toggle_quick_window: { args: void; result: null };
}

export type DesktopCommand = keyof DesktopCommands;
export type DesktopArgs<C extends DesktopCommand> = DesktopCommands[C]['args'];
export type DesktopResult<C extends DesktopCommand> = DesktopCommands[C]['result'];

// ─── Events (shell → web) ────────────────────────────────

export const DESKTOP_EVENT = {
  /** Native application menu requested the web-owned Preferences dialog. */
  openPreferences: 'desktop://open-preferences',
  /**
   * View ▸ Zoom was selected. Payload: `ZoomCommandEvent`. The shell names the
   * intent only; the step ladder and the persisted level live in the web layer.
   */
  zoom: 'desktop://zoom',
  /**
   * An installer download advanced. Payload: `InstallerProgress`. Emitted because
   * the download runs for minutes on the real update source — long enough that a
   * button with no progress reads as hung.
   */
  installerProgress: 'desktop://installer-progress',
  /** The always-on watcher spotted a new selection. Payload: `Selection`. */
  selection: 'desktop://selection',
  /** The last observed selection was cleared. No payload. */
  selectionCleared: 'desktop://selection-cleared',
  /** A global shortcut fired. Payload: `{ id: ShortcutId }`. */
  shortcut: 'desktop://shortcut',
  /** A tray menu entry was clicked. Payload: `TrayAction`. */
  trayAction: 'desktop://tray-action',
} as const;

/** Payload of `DESKTOP_EVENT.zoom`. */
export interface ZoomCommandEvent {
  command: 'in' | 'out' | 'reset';
}
