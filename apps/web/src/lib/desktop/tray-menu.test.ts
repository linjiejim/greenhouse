import { describe, expect, it } from 'vitest';
import { buildTrayMenuModel, trayActionToHandoff, TRAY_PROFILE_LIMIT, TRAY_SESSION_LIMIT } from './tray-menu';

const LABELS = {
  open: 'Open Greenhouse',
  newChat: 'New Chat',
  profiles: 'Agents',
  sessions: 'Recent Chats',
  settings: 'Settings…',
  quit: 'Quit Greenhouse',
};

const NOW = Date.parse('2026-08-03T12:00:00Z');

function minutesAgo(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

function build(overrides: Partial<Parameters<typeof buildTrayMenuModel>[0]> = {}) {
  return buildTrayMenuModel({
    labels: LABELS,
    profiles: [],
    sessions: [],
    now: NOW,
    nowLabel: 'now',
    ...overrides,
  });
}

describe('buildTrayMenuModel', () => {
  it('bubbles running sessions to the top but keeps recency order within each group', () => {
    const model = build({
      sessions: [
        { id: 'a', title: 'Newest idle', updatedAt: minutesAgo(1), running: false },
        { id: 'b', title: 'Running old', updatedAt: minutesAgo(120), running: true },
        { id: 'c', title: 'Older idle', updatedAt: minutesAgo(30), running: false },
      ],
    });
    expect(model.sessions.map((s) => s.id)).toEqual(['b', 'a', 'c']);
    expect(model.sessions[0].running).toBe(true);
  });

  it('trails each session label with a parenthesised age', () => {
    const model = build({
      sessions: [
        { id: 'a', title: 'Fresh', updatedAt: minutesAgo(0), running: false },
        { id: 'b', title: 'Minutes', updatedAt: minutesAgo(3), running: false },
        { id: 'c', title: 'Hours', updatedAt: minutesAgo(120), running: false },
        { id: 'd', title: 'Days', updatedAt: minutesAgo(60 * 24 * 2), running: false },
      ],
    });
    expect(model.sessions.map((s) => s.label)).toEqual(['Fresh (now)', 'Minutes (3m)', 'Hours (2h)', 'Days (2d)']);
  });

  it('marks a running session after the age, so every title starts at the same place', () => {
    const model = build({
      sessions: [{ id: 'a', title: 'Working', updatedAt: minutesAgo(3), running: true }],
    });
    expect(model.sessions[0].label).toBe('Working (3m) 🟢');
  });

  it('passes the configured shortcut through as the open accelerator', () => {
    expect(build({ openAccelerator: 'CmdOrCtrl+G' }).openAccelerator).toBe('CmdOrCtrl+G');
    // Unset is explicit `null`, never `undefined` — the Rust side takes an Option.
    expect(build().openAccelerator).toBeNull();
  });

  it('falls back to a session id stub when the title is empty, and survives a bad timestamp', () => {
    const model = build({
      sessions: [{ id: 'abcdef1234567890', title: '   ', updatedAt: 'not-a-date', running: false }],
    });
    expect(model.sessions[0].label).toBe('abcdef12');
  });

  it('caps both lists and truncates long labels', () => {
    const model = build({
      profiles: Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, label: 'x'.repeat(80) })),
      sessions: Array.from({ length: 15 }, (_, i) => ({
        id: `s${i}`,
        title: `Session ${i}`,
        updatedAt: minutesAgo(i),
        running: false,
      })),
    });
    expect(model.profiles).toHaveLength(TRAY_PROFILE_LIMIT);
    expect(model.sessions).toHaveLength(TRAY_SESSION_LIMIT);
    expect(model.profiles[0].label).toBe(`${'x'.repeat(40)}…`);
  });

  it('puts the preferred Agent first without disturbing the rest of the order', () => {
    const model = build({
      profiles: [
        { id: 'team', label: 'Sprouty' },
        { id: 'deep', label: 'Deep' },
        { id: 'custom-1', label: 'Mine' },
      ],
      preferredProfileId: 'custom-1',
    });
    expect(model.profiles.map((p) => p.id)).toEqual(['custom-1', 'team', 'deep']);
  });
});

describe('trayActionToHandoff', () => {
  it('maps launcher actions onto the existing chat hand-off shapes', () => {
    expect(trayActionToHandoff({ kind: 'newChat' })).toEqual({ target: 'chat', newConversation: true });
    expect(trayActionToHandoff({ kind: 'profile', id: 'team' })).toEqual({
      target: 'chat',
      profileId: 'team',
      newConversation: true,
    });
    expect(trayActionToHandoff({ kind: 'session', id: 's1' })).toEqual({ target: 'chat', sessionId: 's1' });
  });

  it('does not treat settings as a chat hand-off', () => {
    expect(trayActionToHandoff({ kind: 'settings' })).toBeNull();
  });
});
