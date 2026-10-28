/**
 * Design guard (apps/client/DESIGN.md): screens and feature folders take colors and type from
 * src/theme.ts — no raw hex colors, no raw font sizes. The theme, the UI kit (src/ui), vendored
 * and generated files are where those values live. A data color (a chart's series) is allowed on
 * a line that says so: `data color` in a comment on that line or the one above.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { webColors } from './web-colors.generated';

const APP = resolve(__dirname, '../..');
const EXEMPT = [/^src\/theme/, /^src\/ui\//, /^src\/shared\//, /\.generated\.ts$/, /\.test\.ts$/, /^src\/theme\.ts$/, /^src\/theme-m3/];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const HEX = /['"`]#[0-9a-fA-F]{3,8}['"`]/;
const FONT_SIZE = /fontSize:\s*[0-9]/;

describe('design guard', () => {
  const checked = [...files(join(APP, 'app')), ...files(join(APP, 'src'))]
    .map((path) => relative(APP, path))
    .filter((path) => !EXEMPT.some((rule) => rule.test(path)));

  it('checks the screens and feature folders', () => {
    expect(checked.some((path) => path.startsWith('app/'))).toBe(true);
    expect(checked.some((path) => path.startsWith('src/chat/'))).toBe(true);
  });

  it('finds no raw hex colors or raw font sizes there', () => {
    const offenders: string[] = [];
    for (const path of checked) {
      const lines = readFileSync(join(APP, path), 'utf8').split('\n');
      lines.forEach((line, index) => {
        const allowed = /data colou?rs?/i.test(line) || /data colou?rs?/i.test(lines[index - 1] ?? '');
        if ((HEX.test(line) && !allowed) || FONT_SIZE.test(line)) offenders.push(`${path}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('uses only --gh-* variables that the shell defines', () => {
    // defined: every generated web color (kebab-cased), the extras the wide shell sets, and any declared in CSS
    const defined = new Set(
      Object.keys(webColors.light).map((name) => `--gh-${name.replace(/[A-Z]/g, (l) => `-${l.toLowerCase()}`)}`),
    );
    const sources = [...files(join(APP, 'app')), ...files(join(APP, 'src')), ...cssFiles(join(APP, 'src'))];
    for (const path of sources) {
      const text = readFileSync(path, 'utf8');
      for (const m of text.matchAll(/setProperty\(\s*'(--gh-[a-z-]+)'/g)) defined.add(m[1]);
      for (const m of text.matchAll(/^\s*(--gh-[a-z-]+)\s*:/gm)) defined.add(m[1]);
    }
    const missing: string[] = [];
    for (const path of sources) {
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          for (const m of line.matchAll(/var\((--gh-[a-z-]+)/g))
            if (!defined.has(m[1])) missing.push(`${relative(APP, path)}:${index + 1}: ${m[1]}`);
        });
    }
    expect(missing).toEqual([]);
  });
});

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return name.endsWith('.css') ? [path] : [];
  });
}
