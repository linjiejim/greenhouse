#!/usr/bin/env node
/**
 * Plant-avatar gallery — a review sheet rendered from the SHIPPED TypeScript builder
 * (packages/ui/src/components/plant-avatar), so what you look at is what the app paints.
 *
 *   node --import tsx scripts/plant-avatar-gallery.mjs                     # → /tmp/plant-avatar-gallery.png
 *   node --import tsx scripts/plant-avatar-gallery.mjs --out=/tmp/sheet.png
 *   node --import tsx scripts/plant-avatar-gallery.mjs --fit               # re-measure the optical fit
 *
 * The sheet: every preset × 16/24/48/120 in light and dark (+ no disc), 160px portraits,
 * true 1× pixels on the real app surfaces (zoomed ×3, nearest-neighbour), the seven states,
 * the resting moods, and the theme:'auto' markup under a light and a `.dark-theme` ancestor.
 * Static strings everywhere (animate:false), so two runs produce the same pixels.
 *
 * `--fit` measures each species × LOD in Chromium from the unfitted, unrimmed geometry
 * (strokes included), rewrites the FIT block of plant-fit.generated.ts, and reports what
 * changed. Run it after editing any silhouette in plant-catalogue.ts, then review the sheet
 * and update the golden digests (plant-avatar-parity.test.ts, `vitest -u`).
 *
 * Needs Playwright's Chromium (`pnpm exec playwright install chromium`).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const OUT = args.find((a) => a.startsWith('--out='))?.slice(6) || '/tmp/plant-avatar-gallery.png';
const FIT = args.includes('--fit');
const FIT_FILE = fileURLToPath(
  new URL('../packages/ui/src/components/plant-avatar/plant-fit.generated.ts', import.meta.url),
);

let svgModule;
let types;
try {
  svgModule = await import('../packages/ui/src/components/plant-avatar/plant-avatar-svg.ts');
  types = await import('../packages/types/src/plant-avatar.ts');
} catch (err) {
  console.error(
    `Cannot load the TypeScript builder (${err.message}).\nRun with: node --import tsx scripts/plant-avatar-gallery.mjs`,
  );
  process.exit(1);
}
const { buildPlantAvatarSvg, PLANT_AVATAR_CSS } = svgModule;
const { PLANT_IDS, PLANT_STATES, PLANT_MOODS } = types;
const { chromium } = await import('@playwright/test');

/** Real app surfaces (apps/web/src/app.css): canvas / chrome / raised. */
const SURFACE = { white: '#FFFFFF', chrome: '#F1F7ED', raised: '#1A231B', canvas: '#0F1510' };
const LODS = ['glyph', 'avatar', 'portrait'];

const svg = (o) => buildPlantAvatarSvg({ animate: false, theme: 'light', ...o });

const PAGE_CSS = `
*{box-sizing:border-box}
body{margin:0;padding:28px;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1d241e;background:#fff;width:max-content}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px}
.sub{color:#5b6a5d;margin:0 0 12px}
.panel{padding:14px 16px;border-radius:12px;display:inline-block;vertical-align:top}
.panel.l{background:${SURFACE.white};border:1px solid #e3e9e0}.panel.d{background:${SURFACE.raised};color:#e7efe6}
table{border-collapse:collapse}td,th{padding:4px 6px;text-align:center;vertical-align:middle}
th{font-weight:600;font-size:11px;color:inherit;opacity:.75}td.k{text-align:right;font-size:11px;opacity:.75;white-space:nowrap}
.cell{display:inline-flex;align-items:center;justify-content:center}
.portraits{display:grid;grid-template-columns:repeat(8,176px);gap:10px 6px}
.portraits figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:4px;font-size:12px;font-weight:600}
.row{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start}
.strip{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
`;

// ── sections ────────────────────────────────────────────────────────────────

function presetsPanel(theme) {
  const sizes = [16, 24, 48, 120];
  const head = `<tr><th></th>${PLANT_IDS.map((p) => `<th>${p}</th>`).join('')}</tr>`;
  const rows = sizes
    .map(
      (size) =>
        `<tr><td class="k">${size}</td>${PLANT_IDS.map((plant) => `<td>${svg({ plant, size, theme })}</td>`).join('')}</tr>`,
    )
    .join('');
  const noDisc = `<tr><td class="k">24 no disc</td>${PLANT_IDS.map((plant) => `<td>${svg({ plant, size: 24, theme, disc: false })}</td>`).join('')}</tr>`;
  return `<div class="panel ${theme === 'dark' ? 'd' : 'l'}"><table>${head}${rows}${noDisc}</table></div>`;
}

function portraits(theme) {
  const cells = PLANT_IDS.map(
    (plant) => `<figure>${svg({ plant, size: 160, theme })}<span>${plant}</span></figure>`,
  ).join('');
  return `<div class="panel ${theme === 'dark' ? 'd' : 'l'}"><div class="portraits">${cells}</div></div>`;
}

/** True-1× block (captured at DPR 1, then shown zoomed ×3). */
function onePixelBlock() {
  const rows = [
    ['light 16', SURFACE.white, { size: 16, theme: 'light' }],
    ['light 20', SURFACE.white, { size: 20, theme: 'light' }],
    ['light 24', SURFACE.white, { size: 24, theme: 'light' }],
    ['chrome 24', SURFACE.chrome, { size: 24, theme: 'light' }],
    ['no disc 24', SURFACE.white, { size: 24, theme: 'light', disc: false }],
    ['dark 16', SURFACE.raised, { size: 16, theme: 'dark' }],
    ['dark 20', SURFACE.raised, { size: 20, theme: 'dark' }],
    ['dark 24', SURFACE.raised, { size: 24, theme: 'dark' }],
    ['canvas 24', SURFACE.canvas, { size: 24, theme: 'dark' }],
    ['no disc 24', SURFACE.raised, { size: 24, theme: 'dark', disc: false }],
  ];
  const body = rows
    .map(([label, bg, o]) => {
      const fg = bg === SURFACE.white || bg === SURFACE.chrome ? '#5b6a5d' : '#c9d3c8';
      return `<div style="display:flex;align-items:center;gap:6px;background:${bg};padding:3px 6px"><span style="width:64px;font:10px sans-serif;color:${fg}">${label}</span>${PLANT_IDS.map((plant) => `<span style="width:26px;display:inline-flex;justify-content:center">${svg({ plant, ...o })}</span>`).join('')}</div>`;
    })
    .join('');
  return `<div id="px" style="display:inline-block;background:#fff">${body}</div>`;
}

function statesTable() {
  const rows = [
    ['sprout', 24, 'light'],
    ['sprout', 48, 'light'],
    ['sprout', 120, 'light'],
    ['sprout', 48, 'dark'],
    ['clover', 48, 'light'],
    ['lotus', 48, 'light'],
    ['lotus', 48, 'dark'],
    ['sunflower', 48, 'dark'],
    ['maple', 24, 'light'],
  ];
  const head = `<tr><th></th>${PLANT_STATES.map((s) => `<th>${s}</th>`).join('')}</tr>`;
  const body = rows
    .map(([plant, size, theme]) => {
      const bg = theme === 'dark' ? SURFACE.raised : SURFACE.white;
      const fg = theme === 'dark' ? '#c9d3c8' : '#5b6a5d';
      return `<tr style="background:${bg};color:${fg}"><td class="k">${plant} · ${size} · ${theme}</td>${PLANT_STATES.map((state) => `<td>${svg({ plant, size, theme, state })}</td>`).join('')}</tr>`;
    })
    .join('');
  return `<div class="panel l"><table>${head}${body}</table></div>`;
}

function moodsTable() {
  const plants = ['sprout', 'ivy', 'maple', 'echeveria'];
  const head = `<tr><th></th>${PLANT_MOODS.map((m) => `<th>${m}</th>`).join('')}</tr>`;
  const body = plants
    .map(
      (plant) =>
        `<tr><td class="k">${plant}</td>${PLANT_MOODS.map((mood) => `<td>${svg({ plant, size: 64, mood })}</td>`).join('')}</tr>`,
    )
    .join('');
  return `<div class="panel l"><table>${head}${body}</table></div>`;
}

function autoTheme() {
  const strip = PLANT_IDS.map((plant) => svg({ plant, size: 32, theme: 'auto' })).join('');
  return (
    `<div class="row"><div class="panel l"><div class="sub">light ancestor</div><div class="strip">${strip}</div></div>` +
    `<div class="panel d dark-theme"><div class="sub" style="color:#c9d3c8">.dark-theme ancestor — same markup</div><div class="strip">${strip}</div></div></div>`
  );
}

function page(onePx) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_CSS}</style><style data-plant-avatar>${PLANT_AVATAR_CSS}</style></head><body>
<h1>Plant avatars — gallery</h1>
<p class="sub">Rendered from packages/ui/src/components/plant-avatar (static strings). Design spec: docs/specs/assets/avatar-proto/final/spec.md.</p>
<h2>Presets × 16 / 24 / 48 / 120 — light</h2>${presetsPanel('light')}
<h2>Presets × 16 / 24 / 48 / 120 — dark</h2>${presetsPanel('dark')}
<h2>Portraits at 160px</h2><div class="row">${portraits('light')}</div><div class="row" style="margin-top:10px">${portraits('dark')}</div>
<h2>True 1× pixels on the app surfaces (nearest-neighbour ×3)</h2>${onePx}
<h2>States (static poses)</h2>${statesTable()}
<h2>Resting moods (idle)</h2>${moodsTable()}
<h2>theme: 'auto' — one string, switched by the injected CSS</h2>${autoTheme()}
</body></html>`;
}

// ── fit measurement ─────────────────────────────────────────────────────────

async function measureFit(browser) {
  const tab = await browser.newPage({ viewport: { width: 600, height: 400 }, deviceScaleFactor: 1 });
  await tab.setContent('<!doctype html><html><body></body></html>');
  const size = { glyph: 16, avatar: 24, portrait: 120 };
  const items = PLANT_IDS.flatMap((plant) =>
    LODS.map((lod) => ({
      plant,
      lod,
      markup: buildPlantAvatarSvg({ plant, lod, size: size[lod], disc: false, animate: false, raw: true }),
    })),
  );
  const fit = await tab.evaluate((list) => {
    const out = {};
    for (const { plant, lod, markup } of list) {
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;left:-4000px;top:0';
      host.innerHTML = markup;
      const el = host.firstElementChild;
      el.setAttribute('width', '200');
      el.setAttribute('height', '200');
      document.body.append(host);
      const rootInv = el.getScreenCTM().inverse();
      const P = [];
      for (const g of el.querySelectorAll('path,ellipse,circle')) {
        const M = rootInv.multiply(g.getScreenCTM());
        const sw = g.getAttribute('stroke')
          ? (parseFloat(g.getAttribute('stroke-width') || '0') / 2) * Math.hypot(M.a, M.b)
          : 0;
        const len = g.getTotalLength();
        const n = Math.max(24, Math.ceil(len / 1.5));
        for (let i = 0; i <= n; i++) {
          const q = g.getPointAtLength((len * i) / n);
          const t = new DOMPoint(q.x, q.y).matrixTransform(M);
          P.push([t.x, t.y, sw]);
        }
      }
      host.remove();
      const bb = P.reduce(
        (b, [x, y, w]) => [Math.min(b[0], x - w), Math.min(b[1], y - w), Math.max(b[2], x + w), Math.max(b[3], y + w)],
        [1e9, 1e9, -1e9, -1e9],
      );
      const dx = 50 - (bb[0] + bb[2]) / 2;
      const dy = 50 - (bb[1] + bb[3]) / 2;
      let maxR = 0;
      for (const [x, y, w] of P) maxR = Math.max(maxR, Math.hypot(x + dx - 50, y + dy - 50) + w);
      (out[plant] ??= {})[lod] = [+maxR.toFixed(2), +dx.toFixed(1), +dy.toFixed(1)];
    }
    return out;
  }, items);
  await tab.close();
  return fit;
}

function writeFit(fit) {
  const src = readFileSync(FIT_FILE, 'utf8');
  const num = (n) => String(Object.is(n, -0) ? 0 : n);
  const body = PLANT_IDS.map(
    (plant) => `  ${plant}: { ${LODS.map((lod) => `${lod}: [${fit[plant][lod].map(num).join(', ')}]`).join(', ')} },`,
  ).join('\n');
  const block = `// FIT:BEGIN\nexport const PLANT_FIT: Readonly<Record<PlantId, Readonly<Record<PlantLod, PlantFitEntry>>>> = {\n${body}\n};\n// FIT:END`;
  const next = src.replace(/\/\/ FIT:BEGIN[\s\S]*?\/\/ FIT:END/, block);
  if (next === src) {
    console.log('FIT unchanged:', FIT_FILE);
    return;
  }
  writeFileSync(FIT_FILE, next);
  console.log('FIT rewritten:', FIT_FILE, '— review the sheet, then update the golden digests (vitest -u).');
}

// ── main ────────────────────────────────────────────────────────────────────

const browser = await chromium.launch();
try {
  if (FIT) {
    writeFit(await measureFit(browser));
  } else {
    // Pass 1: true 1× pixels at DPR 1.
    const px = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
    await px.setContent(`<!doctype html><html><body style="margin:0">${onePixelBlock()}</body></html>`);
    const shot = await px.locator('#px').screenshot();
    const { width } = (await px.locator('#px').boundingBox()) ?? { width: 0 };
    await px.close();
    const onePx = `<img alt="" src="data:image/png;base64,${shot.toString('base64')}" style="image-rendering:pixelated;display:block;width:${Math.round(width) * 3}px">`;

    // Pass 2: the full sheet.
    const sheet = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
    const errors = [];
    sheet.on('pageerror', (e) => errors.push(e.message));
    await sheet.setContent(page(onePx));
    await sheet.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
    await sheet.screenshot({ path: OUT, fullPage: true });
    await sheet.close();
    if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
    console.log('wrote', OUT);
  }
} finally {
  await browser.close();
}
