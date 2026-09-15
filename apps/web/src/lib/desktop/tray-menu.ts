/**
 * Native tray dropdown — content and click routing.
 *
 * The shell renders the menu; everything in it (localized labels, the Agent
 * list, recent sessions and their running state) is composed here and pushed
 * with `desktop_set_tray_menu`, so the menu stays hot-updatable. Clicks come
 * back as one typed `TrayAction` event and re-enter the app through the same
 * hand-off seam every other launcher surface uses.
 */

import { publishAttachment } from './attach';
import { invokeDesktop, isDesktop, onDesktopEvent } from './bridge';
import { DESKTOP_EVENT } from './types';
import type { TrayAction, TrayMenuModel } from './types';
import type { Handoff } from './handoff';

/** Native menus don't scroll well — keep both lists short by construction. */
export const TRAY_PROFILE_LIMIT = 6;
export const TRAY_SESSION_LIMIT = 4;
const LABEL_MAX_CHARS = 40;
/**
 * Marker for a session that is still generating.
 *
 * An emoji rather than a real icon: `IconMenuItem` only indents the rows that
 * carry an icon, pushing session titles off the menu's left edge, and a native
 * menu icon can only be leading. This keeps the marker green *and* trailing.
 */
const RUNNING_MARKER = '🟢';

export interface TrayProfileSource {
  id: string;
  /** Already localized by the caller (`useLocalized` over `name_i18n`). */
  label: string;
}

export interface TraySessionSource {
  id: string;
  title: string | null;
  updatedAt: string;
  running: boolean;
}

function truncate(text: string): string {
  return text.length > LABEL_MAX_CHARS ? `${text.slice(0, LABEL_MAX_CHARS)}…` : text;
}

/**
 * Like `relativeTime()` but with an injectable clock (the menu re-pushes on a
 * minute tick, so tests need a fixed `now`) and a localizable "now" label.
 */
function compactAge(iso: string, now: number, nowLabel: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const minutes = Math.floor(Math.max(0, now - then) / 60_000);
  if (minutes < 1) return nowLabel;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

/**
 * Compose the model the shell renders. Sessions keep their given (recency)
 * order except that running ones bubble to the top — the menu's job is "jump
 * back into what's working". Native menus can't right-align a second column,
 * so the relative time rides as a label suffix instead.
 */
export function buildTrayMenuModel(input: {
  labels: TrayMenuModel['labels'];
  /** The user's configured `focus_main` binding, shown beside "Open Greenhouse". */
  openAccelerator?: string | null;
  profiles: TrayProfileSource[];
  preferredProfileId?: string | null;
  sessions: TraySessionSource[];
  now: number;
  nowLabel: string;
}): TrayMenuModel {
  const preferred = input.preferredProfileId ?? null;
  const profiles = [...input.profiles]
    .sort((left, right) => Number(right.id === preferred) - Number(left.id === preferred))
    .slice(0, TRAY_PROFILE_LIMIT)
    .map((profile) => ({ id: profile.id, label: truncate(profile.label) }));

  const sessions = [...input.sessions]
    .sort((left, right) => Number(right.running) - Number(left.running))
    .slice(0, TRAY_SESSION_LIMIT)
    .map((session) => {
      const title = truncate(session.title?.trim() || session.id.slice(0, 8));
      const age = compactAge(session.updatedAt, input.now, input.nowLabel);
      // Title first so every row starts at the same place; the age and the
      // running marker trail it. A native menu cannot dim or colour part of one
      // item's title, so the parenthesised age is plain text.
      const suffix = [age && `(${age})`, session.running && RUNNING_MARKER].filter(Boolean).join(' ');
      return {
        id: session.id,
        label: suffix ? `${title} ${suffix}` : title,
        running: session.running,
      };
    });

  return {
    labels: input.labels,
    openAccelerator: input.openAccelerator ?? null,
    profiles,
    sessions,
  };
}

/** Map a click to the chat hand-off it launches; `null` means "not a hand-off". */
export function trayActionToHandoff(action: TrayAction): Handoff | null {
  switch (action.kind) {
    case 'newChat':
      return { target: 'chat', newConversation: true };
    case 'profile':
      return { target: 'chat', profileId: action.id, newConversation: true };
    case 'session':
      return { target: 'chat', sessionId: action.id };
    case 'settings':
      return null;
  }
}

/**
 * Main-window side: route tray clicks. The shell already focused the window;
 * hand-offs go through the existing attachment seam, settings just navigates.
 */
export function listenForTrayActions(): Promise<() => void> {
  return onDesktopEvent<TrayAction>(DESKTOP_EVENT.trayAction, (action) => {
    if (action.kind === 'settings') {
      window.location.hash = '#/settings';
      return;
    }
    const handoff = trayActionToHandoff(action);
    if (handoff) publishAttachment(handoff);
  });
}

/**
 * Push a model to the shell.
 *
 * A failure is tolerated — a dev shell older than the command keeps its static
 * Open/Quit menu (release builds are protected by `minShellVersion`) — but it is
 * never silent: the symptom ("the menu only has Open and Quit") is otherwise
 * indistinguishable from the model being empty, and `console.warn` is forwarded
 * into the shell's log file (which also formats the error).
 */
export async function pushTrayMenu(model: TrayMenuModel): Promise<void> {
  if (!isDesktop()) return;
  try {
    await invokeDesktop('desktop_set_tray_menu', { model });
  } catch (error) {
    console.warn('[tray] menu not pushed:', error);
  }
}
