import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshotClientActions, getClientAction } from '../client-actions/registry';
import { registerDesktopActions } from './native-actions';

/**
 * These actions are shipped to the model as tool definitions by
 * `apps/api/src/tools/client-actions.ts`, which silently DROPS anything malformed.
 * A dropped action is invisible — the agent just never uses the capability — so the
 * backend's validation rules are asserted here instead of discovered in production.
 */

// Mirrors sanitizeClientActions in apps/api/src/tools/client-actions.ts.
const NAME_RE = /^[a-z][a-z0-9_]*$/;
const MAX_NAME_LEN = 64;
const MAX_DESC_LEN = 2000;
const MAX_ACTIONS = 32;
const PAGE_SCOPE = 'page:test:chat';

const EXPECTED = [
  'desktop_capture_screen',
  'desktop_read_selection',
  'desktop_read_clipboard',
  'desktop_write_clipboard',
];

let unregister: () => void;

beforeEach(() => {
  // registerDesktopActions() feature-detects the shell; pretend we're in it.
  (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
  unregister = registerDesktopActions();
});

afterEach(() => {
  unregister();
  delete (globalThis as { window?: unknown }).window;
});

describe('desktop native actions', () => {
  it('registers exactly the expected capabilities', () => {
    const names = snapshotClientActions(PAGE_SCOPE).map((action) => action.name);
    expect(names.sort()).toEqual([...EXPECTED].sort());
  });

  it('survives the backend sanitizer', () => {
    const actions = snapshotClientActions(PAGE_SCOPE);
    expect(actions.length).toBeLessThanOrEqual(MAX_ACTIONS);

    for (const action of actions) {
      expect(action.name).toMatch(NAME_RE);
      expect(action.name.length).toBeLessThanOrEqual(MAX_NAME_LEN);
      expect(action.description.trim()).not.toBe('');
      expect(action.description.length).toBeLessThanOrEqual(MAX_DESC_LEN);
      // Must be a plain object schema — arrays and null are rejected upstream.
      expect(action.parameters).toBeTypeOf('object');
      expect(Array.isArray(action.parameters)).toBe(false);
      expect(action.parameters).not.toBeNull();
      expect((action.parameters as { type?: string }).type).toBe('object');
    }
  });

  it('gates every capability that touches user data behind a confirmation', () => {
    // The agent may ask to read the screen, the selection or the clipboard — the user
    // decides. If one of these ever defaults to 'auto', the model can silently
    // exfiltrate whatever is on screen.
    for (const name of EXPECTED) {
      expect(getClientAction(PAGE_SCOPE, name)?.safety, `${name} must require confirmation`).toBe('confirm');
    }
  });

  it('declares the required argument for clipboard writes', () => {
    const write = getClientAction(PAGE_SCOPE, 'desktop_write_clipboard');
    expect((write?.parameters as { required?: string[] }).required).toEqual(['text']);
  });

  it('registers nothing in a plain browser', () => {
    unregister();
    delete (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {};

    const noop = registerDesktopActions();
    expect(snapshotClientActions(PAGE_SCOPE)).toEqual([]);
    noop();
  });
});
