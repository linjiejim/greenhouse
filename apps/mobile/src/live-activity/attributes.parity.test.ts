/**
 * Drift guard for the Live Activity's data shape (spec docs/specs/20261010-mobile-live-activity.md
 * §3.1, D9). ActivityKit pairs the app's activity with the widget extension's views by the
 * attributes type's name and Codable shape, so `BotTaskAttributes` lives in two byte-identical
 * files — one compiled into the extension, one into the app's WidgetBridge pod — and the app
 * sends it as JSON built in ./model.ts. A drift in any of the three makes the activity silently
 * not show (or not start). Plain file reads: no React Native in the root vitest.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATTRIBUTE_KEYS, STATE_KEYS } from './model';

const MOBILE = resolve(__dirname, '../..');
const WIDGET_COPY = resolve(MOBILE, 'targets/widget/BotTaskAttributes.swift');
const BRIDGE_COPY = resolve(MOBILE, 'modules/widget-bridge/ios/BotTaskAttributes.swift');

/** The stored properties (`var name:`) of a Swift block, in order. */
function properties(swift: string): string[] {
  return [...swift.matchAll(/^\s*var (\w+):/gm)].map((match) => match[1]!);
}

describe('BotTaskAttributes', () => {
  it('is the same file in the widget extension and in the app', () => {
    expect(readFileSync(BRIDGE_COPY, 'utf8')).toBe(readFileSync(WIDGET_COPY, 'utf8'));
  });

  it('declares exactly the keys the app sends', () => {
    const swift = readFileSync(WIDGET_COPY, 'utf8');
    const stateStart = swift.indexOf('struct ContentState');
    const stateEnd = swift.indexOf('\n  }\n', stateStart);
    expect(stateStart).toBeGreaterThan(0);
    const state = swift.slice(stateStart, stateEnd);
    const attributes = swift.slice(0, stateStart) + swift.slice(stateEnd);
    expect(properties(state)).toEqual([...STATE_KEYS]);
    expect(properties(attributes)).toEqual([...ATTRIBUTE_KEYS]);
  });
});
