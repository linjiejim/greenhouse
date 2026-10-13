import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { serve } from './server.mjs';
const output = resolve(process.env.MOTION_QA_OUTPUT || '/tmp/greenhouse-motion-qa');
await mkdir(output, { recursive: true });
const server = await serve(0),
  url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const errors = [],
  report = {
    browser: browser.version(),
    checks: [],
    states: 0,
    limitations: [
      'No physical iPhone, Android or Safari testing.',
      'Background lifecycle tested with a synthetic visibilitychange event; headless tabs do not reproduce OS backgrounding.',
    ],
  };
const page = await browser.newPage({ viewport: { width: 1280, height: 980 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => errors.push(e.message));
const check = (name, result) => {
  assert.ok(result, name);
  report.checks.push(name);
};
try {
  await page.goto(url);
  await page.waitForFunction(() => window.motionReview?.avatars.length === 32);
  check('16 A characters, both versions', (await page.locator('.card').count()) === 16);
  await page.locator('#gallery').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.locator('#pause').click();
  const matrix = await page.evaluate(async () => {
    const { runtime } = await import('./v1/motion.js');
    runtime.paused = false;
    const r = window.motionReview,
      states = ['idle', 'thinking', 'speaking', 'done', 'error', 'waiting', 'sleep', 'hello'];
    let count = 0,
      maxOverflow = 0;
    const roots = r.avatars.map((a) => a.svg),
      paths = r.avatars.map((a) => a.layers.map((l) => l.path.getAttribute('d')).join('|'));
    for (const state of states) {
      r.setGlobal(state);
      for (let f = 0; f < 100; f++) {
        runtime.time += 1 / 60;
        for (const a of r.avatars) {
          a.draw(1 / 60);
          const box = a.svg.getBoundingClientRect();
          for (const { path, group } of a.layers) {
            if (group.style.display === 'none') continue;
            const b = path.getBoundingClientRect();
            maxOverflow = Math.max(
              maxOverflow,
              box.left - b.left,
              b.right - box.right,
              box.top - b.top,
              b.bottom - box.bottom,
            );
          }
        }
      }
      count += 32;
    }
    runtime.paused = true;
    return {
      count,
      maxOverflow,
      stable: r.avatars.every(
        (a, i) => a.svg === roots[i] && a.layers.map((l) => l.path.getAttribute('d')).join('|') === paths[i],
      ),
      same: r.cards.every((c) =>
        c.avatars[0].layers.every((l, i) => l.path.getAttribute('d') === c.avatars[1].layers[i].path.getAttribute('d')),
      ),
    };
  });
  report.states = matrix.count;
  report.maxOverflow = matrix.maxOverflow;
  check('256 version/species/state renders preserve SVG nodes and A paths', matrix.stable && matrix.same);
  check('no path crosses SVG viewport throughout state transitions', matrix.maxOverflow < 0.5);
  await page.evaluate(() => window.motionReview.setGlobal('idle'));
  await page.screenshot({ path: output + '/desktop-comparison.png', fullPage: true });
  await page.locator('#pause').click();
  await page.evaluate(() => window.motionReview.openDetail(0));
  await page.waitForTimeout(100);
  check(
    'gallery suspended while inspecting one character',
    await page.evaluate(() => window.motionReview.cards.every((c) => c.avatars.every((a) => a.suspended))),
  );
  await page.locator('#local-states [data-state=hello]').click();
  await page.waitForTimeout(280);
  const repeat = await page.evaluate(() => {
    const a = window.motionReview.detail.find((a) => a.model && !a.static);
    const before = { age: a.model.age, revision: a.model.revision, values: { ...a.model.values } };
    for (let i = 0; i < 30; i++) window.motionReview.setLocal('hello');
    return {
      same: JSON.stringify(before.values) === JSON.stringify(a.model.values),
      revision: a.model.revision === before.revision,
      age: a.model.age === before.age,
    };
  });
  check('repeat click neither resets nor queues', repeat.same && repeat.revision && repeat.age);
  await page.locator('[data-scenario=interrupt]').click();
  await page.waitForTimeout(2200);
  check(
    'rapid hello→thinking→speaking→error→done→sleep ends cleanly',
    await page.evaluate(() => {
      const a = window.motionReview.detail.find((a) => a.model && !a.static);
      return a.model.state === 'sleep' && a.model.values.mouth < 0.21 && a.model.values.eye < 0.24;
    }),
  );
  await page.locator('[data-scenario=finish]').click();
  await page.waitForTimeout(100);
  await page.locator('#local-states [data-state=speaking]').click();
  await page.waitForTimeout(2000);
  check(
    'new user revision cancels older scenario completion',
    await page.evaluate(() => window.motionReview.detail.filter((a) => !a.static).every((a) => a.state === 'speaking')),
  );
  await page.evaluate(() => window.motionReview.closeDetail());
  await page.locator('#pause').click();
  const paused = await page.evaluate(() =>
    JSON.stringify(window.motionReview.avatars.filter((a) => a.model).map((a) => a.model.values)),
  );
  await page.waitForTimeout(300);
  check(
    'pause freezes values',
    paused ===
      (await page.evaluate(() =>
        JSON.stringify(window.motionReview.avatars.filter((a) => a.model).map((a) => a.model.values)),
      )),
  );
  await page.locator('#pause').click();
  await page.waitForTimeout(200);
  check(
    'resume advances existing instances',
    paused !==
      (await page.evaluate(() =>
        JSON.stringify(window.motionReview.avatars.filter((a) => a.model).map((a) => a.model.values)),
      )),
  );
  await page.locator('#theme').selectOption('dark');
  await page.locator('#size').selectOption('16');
  await page.screenshot({ path: output + '/dark-small.png', fullPage: true });
  check('16px glyph LOD applied', (await page.locator('#gallery svg[data-lod=glyph]').count()) === 32);
  for (const size of ['20', '32', '44', '120']) await page.locator('#size').selectOption(size);
  const contrast = await page.evaluate(() => {
    const lum = (hex) => {
      const rgb = hex
        .match(/[\da-f]{2}/gi)
        .map((v) => parseInt(v, 16) / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    };
    let min = 99;
    for (const c of window.motionReview.cards) {
      const a = c.avatars[1];
      for (const palette of Object.values(a.p.palette)) {
        const x = lum(palette.ink),
          y = lum(palette[a.p.face.tone || 'body']);
        min = Math.min(min, (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05));
      }
    }
    return min;
  });
  report.minFaceContrast = contrast;
  check('base light/dark face contrast >= 4.5', contrast >= 4.5);
  check(
    'no duplicate SVG IDs',
    await page.evaluate(() => {
      const ids = [...document.querySelectorAll('svg [id]')].map((n) => n.id);
      return ids.length === new Set(ids).size;
    }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#theme').selectOption('light');
  await page.evaluate(() => window.motionReview.openDetail(14));
  await page.waitForTimeout(200);
  await page.screenshot({ path: output + '/mobile-sunflower.png' });
  check('390px layout fits viewport', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  for (const width of [320, 390, 620]) {
    await page.setViewportSize({ width, height: 844 });
    check(
      `${width}px portrait fits its host without overlapping controls`,
      await page.evaluate(() =>
        [...document.querySelectorAll('#portraits .avatar-host')].every((h) => {
          const host = h.getBoundingClientRect(),
            svg = h.querySelector('svg').getBoundingClientRect();
          return svg.top >= host.top - 0.5 && svg.bottom <= host.bottom + 0.5;
        }),
      ),
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#local-versions [data-version=v2]').click();
  check(
    'V2-only mode suspends V1',
    await page.evaluate(() => window.motionReview.avatars.filter((a) => a.version === 'v1').every((a) => a.suspended)),
  );
  await page.locator('#local-versions [data-version=v1]').click();
  check(
    'V1-only mode suspends V2',
    await page.evaluate(() => window.motionReview.avatars.filter((a) => a.version === 'v2').every((a) => a.suspended)),
  );
  await page.locator('#local-versions [data-version=compare]').click();
  await page.locator('#local-speed').selectOption('0.5');
  check(
    'detail speed control updates shared runtime',
    await page.evaluate(() => window.motionReview.diagnostics().speed === 0.5),
  );
  await page.locator('#local-speed').selectOption('1');
  for (let i = 0; i < 16; i++) {
    await page.evaluate((i) => window.motionReview.openDetail(i), i);
    check(`mobile character ${i + 1} exposes 8 states`, (await page.locator('#state-sheet button').count()) === 8);
  }
  await page.evaluate(() => window.motionReview.openDetail(0));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(100);
  await page.locator('#local-states [data-state=hello]').click();
  const still = await page.evaluate(() => window.motionReview.detail.find((a) => a.model && !a.static).pose.outerHTML);
  await page.waitForTimeout(250);
  check(
    'reduced-motion responds to state and remains stationary',
    still === (await page.evaluate(() => window.motionReview.detail.find((a) => a.model && !a.static).pose.outerHTML)),
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => window.motionReview.closeDetail());
  await page.locator('#demo').click();
  await page.waitForTimeout(2700);
  check('continuous demo advances text and state', await page.evaluate(() => window.motionReview.state !== 'hello'));
  await page.locator('#demo').click();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const hidden = await page.evaluate(() => window.motionReview.diagnostics().time);
  await page.waitForTimeout(250);
  check(
    'visibility handler freezes the clock (synthetic event)',
    hidden === (await page.evaluate(() => window.motionReview.diagnostics().time)),
  );
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.setViewportSize({ width: 1280, height: 980 });
  await page.locator('#gallery').scrollIntoViewIfNeeded();
  const costs = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const values = [];
        function frame() {
          values.push(window.motionReview.diagnostics().lastCost);
          if (values.length === 120) {
            document.removeEventListener('motion-frame', frame);
            resolve(values.sort((a, b) => a - b));
          }
        }
        document.addEventListener('motion-frame', frame);
      }),
  );
  report.drawCostP95Ms = costs[Math.floor(costs.length * 0.95)];
  report.instances = await page.evaluate(() => window.motionReview.diagnostics());
  check('visible animation draw p95 < 16ms', report.drawCostP95Ms < 16);
  check('no browser exceptions', errors.length === 0);
  // Evidence-only static contact sheet: no 128-instance live animation surface.
  await page.setViewportSize({ width: 1320, height: 1800 });
  await page.evaluate(async () => {
    const { V2Avatar } = await import('./v2/avatar.js');
    const { META, STATES, LABELS, settings } = await import('./v1/motion.js');
    for (const a of window.motionReview.avatars) a.dispose();
    settings({ paused: true, theme: 'light' });
    document.documentElement.dataset.theme = 'light';
    document.body.innerHTML =
      '<div id="proof" style="padding:24px"><h2>V2 · 16 个角色 × 8 种表情</h2><p>真实 Chromium 静态对照 · A 轮廓不变</p></div>';
    const proof = document.querySelector('#proof');
    for (const [plant, name] of META) {
      const row = document.createElement('div');
      row.style.cssText =
        'display:grid;grid-template-columns:110px repeat(8,1fr);align-items:center;border-top:1px solid #dce3d8;padding:8px 0';
      const label = document.createElement('strong');
      label.textContent = name;
      row.append(label);
      STATES.forEach((state, i) => {
        const cell = document.createElement('div');
        cell.style.textAlign = 'center';
        const host = document.createElement('div');
        host.style.cssText = 'display:flex;justify-content:center';
        cell.append(host);
        new V2Avatar(host, plant, { state, static: true, size: 72 });
        const text = document.createElement('div');
        text.textContent = LABELS[i];
        text.style.fontSize = '11px';
        cell.append(text);
        row.append(cell);
      });
      proof.append(row);
    }
  });
  await page.screenshot({ path: output + '/v2-expression-matrix.png', fullPage: true });
  await writeFile(output + '/report.json', JSON.stringify({ ...report, errors }, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
