/**
 * Type-scale guard: nothing on screen renders below 12px (the `caption` role in
 * packages/ui/src/tokens/tokens.ts). Use `text-caption` (12/16) or `text-label` (13/18) instead of
 * arbitrary sizes. Scans the web app and the packages it renders (crud, ui) for Tailwind arbitrary
 * sizes, inline `fontSize`, CSS `font-size` and canvas font objects.
 *
 * An exception needs an ALLOW entry with the reason; keep it to surfaces that are not screen text.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../../..');
const SCANNED = ['apps/web/src', 'packages/crud/src', 'packages/ui/src'];
const MIN_PX = 12;

/** path → reason. Only for text that is not screen UI. */
const ALLOW: Record<string, string> = {
  // The printed page footer of a PDF export (print CSS on paper, not screen text).
  'apps/web/src/components/pdf-export.tsx': 'print footer',
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules') return [];
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const RULES: Array<[RegExp, (match: RegExpExecArray) => number]> = [
  [/text-\[(\d+(?:\.\d+)?)px\]/g, (m) => Number(m[1])],
  [/text-\[(\d*\.\d+|\d+)rem\]/g, (m) => Number(m[1]) * 16],
  [/fontSize:\s*['"]?(\d+(?:\.\d+)?)(?:px)?['"]?/g, (m) => Number(m[1])],
  [/font-size:\s*(\d+(?:\.\d+)?)px/g, (m) => Number(m[1])],
  [/font:\s*\{\s*size:\s*(\d+(?:\.\d+)?)/g, (m) => Number(m[1])],
];

describe('type-scale guard', () => {
  const checked = SCANNED.flatMap((dir) => files(resolve(ROOT, dir))).map((path) => relative(ROOT, path));

  it('scans the web app', () => {
    expect(checked).toContain('apps/web/src/app.css');
    expect(checked.length).toBeGreaterThan(100);
  });

  it(`finds no screen text below ${MIN_PX}px`, () => {
    const offenders: string[] = [];
    for (const path of checked) {
      if (ALLOW[path]) continue;
      const lines = readFileSync(resolve(ROOT, path), 'utf8').split('\n');
      lines.forEach((line, index) => {
        for (const [pattern, size] of RULES) {
          for (const match of line.matchAll(pattern)) {
            if (size(match as RegExpExecArray) < MIN_PX) offenders.push(`${path}:${index + 1}: ${match[0]}`);
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
