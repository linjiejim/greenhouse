/**
 * What this machine can actually do.
 *
 * The desktop features all depend on OS grants that can be revoked at any time, and
 * both macOS gates fail *silently* when missing — an event tap delivers nothing, a
 * capture returns the desktop picture. So the UI must ask rather than assume, and
 * must say why something is unavailable instead of showing a button that does nothing.
 */

import { invokeDesktop, isDesktop } from './bridge';
import type { Availability, DesktopCapabilities, Permission } from './types';

const UNAVAILABLE: DesktopCapabilities = {
  capture: { state: 'unsupported', reason: 'Only available in the Greenhouse desktop app' },
  selection: { state: 'unsupported', reason: 'Only available in the Greenhouse desktop app' },
  clipboard: { state: 'unsupported', reason: 'Only available in the Greenhouse desktop app' },
  permissions: { accessibility: false, screenRecording: false, applicable: false },
  selectionWatch: false,
  interactiveCapture: false,
};

let cached: DesktopCapabilities | null = null;
const listeners = new Set<(caps: DesktopCapabilities) => void>();

/**
 * Read capabilities, refreshing from the shell unless a cached copy is acceptable.
 *
 * Permissions change outside the app (the user walks to System Settings and back),
 * so anything user-facing should pass `{ refresh: true }` when the window regains
 * focus rather than trusting the cache.
 */
export async function getCapabilities(options: { refresh?: boolean } = {}): Promise<DesktopCapabilities> {
  if (!isDesktop()) return UNAVAILABLE;
  if (cached && !options.refresh) return cached;
  try {
    cached = await invokeDesktop('desktop_capabilities');
  } catch {
    // A shell too old to know this command is indistinguishable from no shell here.
    cached = UNAVAILABLE;
  }
  listeners.forEach((listener) => listener(cached!));
  return cached;
}

/** Last known capabilities without a round-trip; null before the first read. */
export function peekCapabilities(): DesktopCapabilities | null {
  return cached;
}

export function onCapabilitiesChange(listener: (caps: DesktopCapabilities) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Ask the OS for a permission, then refresh (the grant may not have been given). */
export async function requestPermission(permission: Permission): Promise<DesktopCapabilities> {
  await invokeDesktop('desktop_request_permission', { permission });
  return getCapabilities({ refresh: true });
}

/** A human-readable reason, for a tooltip next to a disabled control. */
export function explainAvailability(availability: Availability): string | null {
  switch (availability.state) {
    case 'available':
      return null;
    case 'needs_permission':
      return availability.permission === 'accessibility'
        ? 'Needs macOS Accessibility permission'
        : 'Needs macOS Screen Recording permission';
    case 'unsupported':
      return availability.reason;
  }
}
