#!/usr/bin/env node
/**
 * iOS widget art — rasterises the built-in Sprouty's plant avatar (plant 'sprout') from the
 * vendored STATIC builder (src/ui/plant-avatar), so the widget shows exactly what the app paints.
 *
 *   node --import tsx apps/mobile/scripts/render-widget-art.mjs        # from the repo root
 *
 * Needs `rsvg-convert` (librsvg — the SVG engine behind sharp; `brew install librsvg`) and the
 * root workspace's tsx. Writes 1024×1024 PNGs into targets/widget/ (the sources the
 * @bacons/apple-targets `images` config points at) and mirrors each into the committed
 * Assets.xcassets/<name>.imageset/1x.png that prebuild would regenerate from them:
 *
 *   sprouty-idle.png / -sleep.png            light palette   → assets sprouty / sproutySleep
 *   sprouty-idle-dark.png / -sleep-dark.png  dark palette    → assets sproutyDark / sproutySleepDark
 *   sprouty-mono.png                         knockout        → asset  sproutyMono
 *
 * The colour art is drawn at a 48px design size (portrait detail: the small face, brows and the
 * sleep state's Zzz mark), then scaled to 1024: the widget shows it at 30–80pt. The mono art is the lock-screen
 * accessory silhouette (22pt rectangular / circular families, which iOS tints): white
 * silhouette with the eyes punched out as transparent holes — the eyes layer is applied as
 * destination-out (a luminance mask, export-only; the builder itself never emits ids/masks).
 * Re-run after any change to the vendored builder; new PNGs are a native change → EAS build.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

const WIDGET = fileURLToPath(new URL('../targets/widget/', import.meta.url));
const PX = 1024;

let builder;
try {
  builder = await import('../src/ui/plant-avatar/plant-avatar-svg.ts');
} catch (err) {
  process.stderr.write(
    `Cannot load the TypeScript builder (${err.message}).\n` +
      'Run from the repo root: node --import tsx apps/mobile/scripts/render-widget-art.mjs\n',
  );
  process.exit(1);
}
const { buildPlantAvatarSvg, buildPlantMonoLayers } = builder;

/** Strip the outer <svg …> wrapper, keeping the 100×100 viewBox content. */
const inner = (svg) => svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');

function knockout(layers) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${PX}" height="${PX}">` +
    `<mask id="eyes" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">` +
    `<rect width="100" height="100" fill="#FFFFFF"/><g color="#000000">${inner(layers.eyes)}</g></mask>` +
    `<g mask="url(#eyes)" color="#FFFFFF">${inner(layers.silhouette)}</g></svg>`
  );
}

const ART = [
  { file: 'sprouty-idle.png', asset: 'sprouty', svg: buildPlantAvatarSvg({ state: 'idle', size: 48, theme: 'light' }) },
  {
    file: 'sprouty-sleep.png',
    asset: 'sproutySleep',
    svg: buildPlantAvatarSvg({ state: 'sleep', size: 48, theme: 'light' }),
  },
  {
    file: 'sprouty-idle-dark.png',
    asset: 'sproutyDark',
    svg: buildPlantAvatarSvg({ state: 'idle', size: 48, theme: 'dark' }),
  },
  {
    file: 'sprouty-sleep-dark.png',
    asset: 'sproutySleepDark',
    svg: buildPlantAvatarSvg({ state: 'sleep', size: 48, theme: 'dark' }),
  },
  { file: 'sprouty-mono.png', asset: 'sproutyMono', svg: knockout(buildPlantMonoLayers({ state: 'idle', size: 32 })) },
];

/** What @bacons/apple-targets writes for a single-scale `images` entry. */
const CONTENTS = {
  images: [
    { idiom: 'universal', scale: '1x', filename: '1x.png' },
    { idiom: 'universal', scale: '2x' },
    { idiom: 'universal', scale: '3x' },
  ],
  info: { version: 1, author: 'expo' },
};

for (const { file, asset, svg } of ART) {
  const png = execFileSync('rsvg-convert', ['--width', String(PX), '--height', String(PX), '--format', 'png'], {
    input: svg,
    maxBuffer: 32 * 1024 * 1024,
  });
  writeFileSync(WIDGET + file, png);
  const set = `${WIDGET}Assets.xcassets/${asset}.imageset/`;
  mkdirSync(set, { recursive: true });
  writeFileSync(set + '1x.png', png);
  writeFileSync(set + 'Contents.json', JSON.stringify(CONTENTS, null, 2)); // no trailing newline, as the plugin writes
  process.stdout.write(`${file} → ${asset}.imageset (${(png.length / 1024).toFixed(1)} KB)\n`);
}
