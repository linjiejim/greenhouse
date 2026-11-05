#!/usr/bin/env node
/**
 * Design guard for plugin front ends (plugins/<id>/ui-src/src and the static plugins/<id>/ui):
 * embeds take type, colour, overlays and feedback from @greenhouse/ui-tokens (preset + kit), so
 * a framed page looks and behaves like the host (apps/client/DESIGN.md, Embeds).
 *
 * A plugin may carry known debt in `plugins/<id>/design-baseline.json` ({ "<rule>": count });
 * a count can only go down, and a plugin without the file must be clean.
 *
 *   node scripts/check-plugin-ui.mjs            # check every plugin
 *   node scripts/check-plugin-ui.mjs --report   # print every offending line
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RULES = {
  'arbitrary-text': {
    pattern: /\btext-\[\d+(?:\.\d+)?px\]/,
    why: 'font size outside the preset (use text-caption … text-title-lg)',
  },
  'raw-colour': {
    pattern: /(?:['"`(\s:]#[0-9a-fA-F]{3,8}\b)|\b(?:bg|text|border|ring|from|to)-(?:black|white)\b|\brgba?\(/,
    why: 'raw colour (use the semantic tokens)',
  },
  'heavy-weight': {
    pattern: /\bfont-(?:bold|extrabold|black)\b|font-weight:\s*(?:[7-9]00|bold)/,
    why: 'weight above 600',
  },
  'hand-overlay': {
    pattern: /\bfixed\s+inset-0\b|position:\s*fixed;[^}]*inset:\s*0/,
    why: 'hand-written overlay (use the kit Dialog / Drawer)',
  },
  blur: { pattern: /\bbackdrop-blur/, why: 'blurred scrim' },
  'error-toast': {
    pattern: /\btoastError\(|toast\([^)]*['"]error['"]\)/,
    why: 'error in a vanishing toast (use host.notify error or an inline error)',
  },
  'native-dialog': { pattern: /\bwindow\.(?:confirm|alert|prompt)\(/, why: 'browser dialog (use host.confirm)' },
};

const ALLOW = /design-allow/;

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist'].includes(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : /\.(?:[cm]?[jt]sx?|css|html)$/.test(entry.name) ? [path] : [];
  });
}

export function scanPlugin(dir) {
  const files = [
    ...walk(join(dir, 'ui-src', 'src')),
    ...walk(join(dir, 'ui')),
    ...(existsSync(join(dir, 'ui-src', 'index.html')) ? [join(dir, 'ui-src', 'index.html')] : []),
  ];
  const hits = Object.fromEntries(Object.keys(RULES).map((rule) => [rule, []]));
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      if (ALLOW.test(line) || ALLOW.test(lines[index - 1] ?? '')) return;
      for (const [rule, { pattern }] of Object.entries(RULES))
        if (pattern.test(line)) hits[rule].push(`${file}:${index + 1}: ${trimmed.slice(0, 120)}`);
    });
  }
  return hits;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = process.argv.includes('--report');
  const failures = [];
  for (const id of existsSync('plugins') ? readdirSync('plugins').sort() : []) {
    const dir = join('plugins', id);
    if (!existsSync(join(dir, 'ui-src')) && !existsSync(join(dir, 'ui'))) continue;
    const baselineFile = join(dir, 'design-baseline.json');
    const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : {};
    const hits = scanPlugin(dir);
    for (const [rule, lines] of Object.entries(hits)) {
      const allowed = baseline[rule] ?? 0;
      if (report && lines.length) console.log(`${id} ${rule} (${lines.length}/${allowed}):\n  ${lines.join('\n  ')}`);
      if (lines.length > allowed)
        failures.push(
          `${id}: ${rule} ${lines.length} > ${allowed} — ${RULES[rule].why}\n  ${lines.slice(0, 5).join('\n  ')}`,
        );
      else if (lines.length < allowed)
        failures.push(`${id}: ${rule} is down to ${lines.length}; lower ${baselineFile} to ${lines.length}`);
    }
  }
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else console.log('✓ plugin UI design guard');
}
