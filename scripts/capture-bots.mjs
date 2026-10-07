#!/usr/bin/env node
/**
 * Live tour of the Bots feature — screenshots + a short video for the report.
 *
 * Drives a running dev stack started with `node scripts/run-dev.mjs up web --bots`
 * as a Chinese-locale team member, against the REAL configured model and REAL
 * computers (nothing is stubbed): first run, the template gallery, a Bot
 * browsing on its computer while you watch, a group hand-off, signing in with
 * the password vault (approval card + TOTP), the secure sign-in card, a
 * background task, the profile drawer and info pane, the computer as a
 * computer (taskbar and minimise recovery, terminal, files, a background
 * process), a human check on the demo site's verify.html handed to the member
 * and passed on the card, "handle now", the admin page, mobile.
 *
 * The demo site (tests/fixtures/bots-demo-site) is served inside the member's
 * computer on http://localhost:8000 (vault entry) and :8001 (no vault entry, for
 * the secure sign-in card) — the dev-only origin exception.
 *
 *   E2E_BASE_URL=http://localhost:3110 node scripts/capture-bots.mjs
 *   BOTS_TOUR_MEMBER_EMAIL=… BOTS_TOUR_MEMBER_PASSWORD=… node scripts/capture-bots.mjs   # another member
 *   BOTS_TOUR_OUT=docs/specs/assets/bots-next node scripts/capture-bots.mjs           # another output folder
 *
 * The member should start with no Bots (the tour opens on the first visit).
 *   node scripts/capture-bots.mjs --only browse,vault   # login always runs
 *   node scripts/capture-bots.mjs --no-video
 *
 * Writes PNGs (+ WebP when cwebp exists) and bots-tour.{mp4,gif} into
 * docs/specs/assets/bots/ (or BOTS_TOUR_OUT). Exits non-zero when a step fails.
 */

import { chromium } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3110';
// BOTS_TOUR_OUT keeps an earlier report's screenshots intact.
const OUT = resolve(process.cwd(), process.env.BOTS_TOUR_OUT || 'docs/specs/assets/bots');
// Defaults are the example dataset's documented demo accounts (`pnpm seed`,
// data/examples/users.json); point the tour at other accounts through env.
const MEMBER = {
  email: process.env.BOTS_TOUR_MEMBER_EMAIL || 'priya@greenhouse.example',
  password: process.env.BOTS_TOUR_MEMBER_PASSWORD || 'greenhouse',
};
const ADMIN = {
  email: process.env.BOTS_TOUR_ADMIN_EMAIL || 'maya@greenhouse.example',
  password: process.env.BOTS_TOUR_ADMIN_PASSWORD || 'greenhouse',
};
// The demo portal's own fixture login (tests/fixtures/bots-demo-site), not an account.
const DEMO = { email: 'jim@acme.test', password: 'Greenhouse-Demo-2026!', totp: 'JBSWY3DPEHPK3PXP' };
const args = process.argv.slice(2);
const NO_VIDEO = args.includes('--no-video');
const ONLY = (() => {
  const i = args.indexOf('--only');
  return i >= 0 ? new Set(args[i + 1].split(',')) : null;
})();
const VIEW = { width: 1440, height: 900 };

mkdirSync(OUT, { recursive: true });
const report = [];
const log = (msg) => console.log(msg);

// ─── API helpers ─────────────────────────────────────────

async function loginApi(account) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(account),
  });
  if (!res.ok) throw new Error(`login ${account.email} → ${res.status}`);
  return (await res.json()).accessToken;
}

function apiClient(token) {
  return async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
    return json;
  };
}

/** Wait until no chat run is active for this conversation (the Bots finished speaking). */
async function waitIdle(api, sessionId, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  await new Promise((r) => setTimeout(r, 1500));
  while (Date.now() < deadline) {
    const { runs } = await api('GET', '/api/chat/runs');
    if (!runs.some((r) => r.session_id === sessionId)) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`conversation ${sessionId} still busy after ${timeoutMs / 1000}s`);
}

/** Wait for a pending "needs you" request of one kind in a conversation. */
async function waitRequest(api, sessionId, kinds, timeoutMs = 180_000, skipIds = []) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { requests } = await api('GET', '/api/bots/requests?status=pending');
    const hit = requests.find((r) => r.session_id === sessionId && kinds.includes(r.kind) && !skipIds.includes(r.id));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`no ${kinds.join('/')} request in ${sessionId}`);
}

function totp(secret, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(at / 30_000), 4);
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** The member's computer container (created by the API on first use). */
function computerContainer(userId) {
  const out = execFileSync(
    'docker',
    ['ps', '--filter', `label=greenhouse.bots.computer.user=${userId}`, '--format', '{{.Names}}'],
    {
      encoding: 'utf8',
    },
  ).trim();
  return out.split('\n').filter(Boolean)[0] ?? null;
}

/** Serve the demo portal inside the computer on :8000 and :8001 (idempotent). */
function startDemoSite(container) {
  // Unpacked as `agent` (the computer drops every capability, so root could
  // not chown a `docker cp` afterwards).
  const archive = execFileSync('tar', ['--no-xattrs', '-C', 'tests/fixtures/bots-demo-site', '-cf', '-', '.']);
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      '-u',
      'agent',
      container,
      'sh',
      '-c',
      'mkdir -p /home/agent/work/acme && tar -xf - -C /home/agent/work/acme',
    ],
    { input: archive },
  );
  for (const port of [8000, 8001]) {
    const up = spawnSync('docker', ['exec', container, 'curl', '-fs', '-o', '/dev/null', `http://127.0.0.1:${port}/`]);
    if (up.status === 0) continue;
    // A gh-jobs job, not a bare `docker exec -d`: a take-over kills the agent's
    // stray processes but spares jobs, and the human-check step takes over.
    execFileSync('docker', [
      'exec',
      '-u',
      'agent',
      '-e',
      'HOME=/home/agent',
      '-w',
      '/home/agent',
      container,
      'gh-jobs',
      'start',
      '--name',
      `acme-demo-${port}`,
      '--',
      `python3 -m http.server ${port} --bind 127.0.0.1 --directory /home/agent/work/acme`,
    ]);
  }
}

// ─── Browser helpers ─────────────────────────────────────

function attachDiagnostics(page, label) {
  const issues = [];
  page.on('console', (m) => {
    // "Failed to load resource" carries no URL; the response listener below
    // reports the request itself (and knows which 404s are expected).
    if (m.type() === 'error' && !/release-notes|ERR_CONNECTION|WebSocket|Failed to load resource/.test(m.text()))
      issues.push(`console: ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => issues.push(`pageerror: ${String(e).slice(0, 200)}`));
  page.on('response', (r) => {
    const url = r.url();
    // 5xx anywhere under /api, and any 404 (a missing route or asset is a bug;
    // the console line alone does not say which URL).
    // Dev builds don't generate the release-notes files the shell polls for.
    if ((r.status() >= 500 && url.includes('/api/')) || (r.status() === 404 && !url.includes('/release-notes')))
      issues.push(`${r.request().method()} ${url.replace(BASE, '')} → ${r.status()}`);
  });
  return { label, issues };
}

async function settle(page, ms = 800) {
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(ms);
}

async function snap(page, name, opts = {}) {
  await settle(page, opts.wait ?? 800);
  await page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage: false });
  log(`  📸 ${name}`);
}

async function step(name, fn) {
  if (ONLY && !ONLY.has(name) && name !== 'login') return;
  log(`▶ ${name}`);
  try {
    await fn();
    report.push({ name, ok: true });
  } catch (err) {
    report.push({ name, ok: false, error: String(err).slice(0, 400) });
    log(`  ✗ ${name}: ${String(err).slice(0, 400)}`);
  }
}

async function loginUi(page, account) {
  await page.goto(`${BASE}/`);
  await page.getByTestId('login-email').fill(account.email);
  await page.getByTestId('login-password').fill(account.password);
  await page.getByTestId('login-submit').click();
  await page.getByTestId('chat-input').waitFor({ timeout: 30_000 });
}

async function openConversation(page, sessionId) {
  await page.goto(`${BASE}/#/bots?c=${sessionId}`);
  await page.getByTestId('bots-transcript').waitFor({ timeout: 30_000 });
  await settle(page, 600);
}

async function send(page, text) {
  const box = page.getByTestId('bots-conversation').getByRole('textbox').last();
  await box.click();
  await box.fill(text);
  await box.press('Enter');
}

async function openComputerPane(page) {
  if ((await page.getByTestId('computer-pane').count()) === 0) await page.getByTestId('bots-computer-button').click();
  await page.getByTestId('computer-pane').waitFor({ timeout: 20_000 });
}

async function waitScreen(page) {
  await page.getByTestId('computer-screen').locator('canvas').first().waitFor({ timeout: 45_000 });
  await page.waitForTimeout(1500);
}

// ─── Tour ────────────────────────────────────────────────

const browser = await chromium.launch();
const memberToken = await loginApi(MEMBER);
const api = apiClient(memberToken);
const me = (await api('GET', '/api/auth/me')).user ?? (await api('GET', '/api/auth/me'));
const state = {};
let page;
let diag;

async function newPage(video = false) {
  const context = await browser.newContext({
    viewport: VIEW,
    locale: 'zh-CN',
    ...(video ? { recordVideo: { dir: resolve(OUT, 'video-raw'), size: VIEW } } : {}),
  });
  await context.addInitScript(() => {
    if (!localStorage.getItem('greenhouse-theme')) localStorage.setItem('greenhouse-theme', 'light');
  });
  const p = await context.newPage();
  return p;
}

/** Steps re-run alone (`--only`) find the tour's Bots by template. */
async function ensureBots() {
  if (!state.group) {
    const { conversations } = await api('GET', '/api/bots/conversations');
    state.group = conversations.find((c) => c.kind === 'group')?.session_id;
  }
  if (state.ivy && state.basil) return;
  const { bots } = await api('GET', '/api/bots');
  state.ivy ??= bots.find((b) => b.template_key === 'chief') ?? bots[0];
  state.sage ??= bots.find((b) => b.template_key === 'researcher');
  state.fern ??= bots.find((b) => b.template_key === 'writer');
  state.basil ??= bots.find((b) => b.template_key === 'operator');
}

await step('login', async () => {
  page = await newPage();
  diag = attachDiagnostics(page, 'member');
  await loginUi(page, MEMBER);
});

await step('first-run', async () => {
  await page.goto(`${BASE}/#/bots`);
  await page.getByTestId('bots-starters').waitFor({ timeout: 40_000 });
  await snap(page, '01-first-run', { wait: 1500 });
  const { bots } = await api('GET', '/api/bots');
  state.ivy = bots.find((b) => b.template_key === 'chief') ?? bots[0];
});

await step('gallery', async () => {
  const { bots } = await api('GET', '/api/bots');
  state.ivy ??= bots.find((b) => b.template_key === 'chief') ?? bots[0];
  await page
    .getByRole('button', { name: /新建 Bot|New Bot/ })
    .first()
    .click();
  await page.getByTestId('bots-template-gallery').waitFor();
  await snap(page, '02-template-gallery');
  await page.keyboard.press('Escape');
  for (const key of ['researcher', 'writer', 'operator']) {
    if (!bots.some((b) => b.template_key === key)) await api('POST', '/api/bots', { template_key: key });
  }
  const after = (await api('GET', '/api/bots')).bots;
  state.sage = after.find((b) => b.template_key === 'researcher');
  state.fern = after.find((b) => b.template_key === 'writer');
  state.basil = after.find((b) => b.template_key === 'operator');
});

await step('browse', async () => {
  const dm = state.ivy.dm_session_id;
  await openConversation(page, dm);
  await send(
    page,
    '帮我在电脑上用必应搜索「gVisor systrap」，打开第一条官方结果，用三句话告诉我它解决了什么问题，并附上链接。',
  );
  await page.getByTestId('bots-live-segment').waitFor({ timeout: 30_000 });
  await openComputerPane(page);
  await waitScreen(page);
  await page.waitForTimeout(6000);
  await snap(page, '03-browsing-live', { wait: 300 });
  await waitIdle(api, dm);
  await snap(page, '04-browse-answer', { wait: 1500 });
});

await step('handoff', async () => {
  const { conversation } = await api('POST', '/api/bots/conversations', {
    bot_ids: [state.ivy.id, state.sage.id, state.fern.id],
    title: '发布会筹备',
  });
  state.group = conversation.session_id;
  await openConversation(page, state.group);
  await send(
    page,
    '我们下周要介绍 Greenhouse 的 Bots 功能。请小研先在网上查一下 Grok Bot、Meta Muse、OpenAI dots 各自最核心的一个卖点，再请小文据此写一段 120 字左右的中文开场白。',
  );
  await waitIdle(api, state.group, 420_000);
  await snap(page, '05-group-handoff', { wait: 1500 });
  await page.getByTestId('bots-transcript').evaluate((el) => el.scrollTo({ top: 0 }));
  await snap(page, '05b-group-handoff-top', { wait: 800 });
});

await step('vault', async () => {
  await ensureBots();
  const dm = state.ivy.dm_session_id;
  const container = computerContainer(me.id);
  if (!container) throw new Error('the member has no running computer yet');
  startDemoSite(container);
  const { items } = await api('GET', '/api/bots/vault');
  if (!items.some((i) => i.label === 'Acme 采购门户')) {
    await api('POST', '/api/bots/vault', {
      label: 'Acme 采购门户',
      origins: ['http://localhost:8000'],
      username: DEMO.email,
      password: DEMO.password,
      totp: DEMO.totp,
      policy: 'ask',
    });
  }
  await openConversation(page, dm);
  await send(
    page,
    '打开 http://localhost:8000 ，用密码库里的账号登录 Acme 采购门户（需要的话也用动态码），然后告诉我九月有哪些订单还没完成付款或审批，列成表。',
  );
  for (let round = 0; round < 3; round++) {
    const request = await waitRequest(api, dm, ['approval'], 150_000).catch(() => null);
    if (!request) break;
    await page.getByTestId('bots-request-card').last().waitFor();
    if (round === 0) await snap(page, '06-vault-approval', { wait: 600 });
    await page
      .getByTestId('bots-request-card')
      .last()
      .getByRole('button', { name: /允许一次|Allow once/ })
      .click();
    await page.waitForTimeout(2500);
  }
  await waitIdle(api, dm, 300_000);
  await snap(page, '07-vault-result', { wait: 1500 });
  await openComputerPane(page);
  await waitScreen(page);
  await snap(page, '08-computer-orders', { wait: 800 });
});

await step('passwords', async () => {
  await page.goto(`${BASE}/#/settings/passwords`);
  await settle(page, 1500);
  await snap(page, '09-passwords');
});

await step('secure-login', async () => {
  await ensureBots();
  // Self-sufficient when re-run alone: the computer may have been recycled
  // since the vault step, taking the demo portal's processes with it.
  await api('POST', '/api/bots/computer/start');
  const container = computerContainer(me.id);
  if (!container) throw new Error('the member has no running computer');
  startDemoSite(container);
  const dm = state.basil.dm_session_id;
  await openConversation(page, dm);
  await send(
    page,
    '请打开 http://localhost:8001 ，帮我登录 Acme 采购门户（这个地址密码库里没有，需要我来填），登录后告诉我订单总金额。',
  );
  const request = await waitRequest(api, dm, ['login'], 240_000);
  const card = page.getByTestId('bots-request-card').last();
  await card.waitFor();
  await snap(page, '10-secure-login-card', { wait: 800 });
  await card.getByLabel(/用户名|Username/).fill(DEMO.email);
  await card.getByLabel(/^密码$|^Password$/).fill(DEMO.password);
  await card.getByRole('button', { name: /^登录$|^Sign in$/ }).click();
  // A two-step sign-in raises a second card for the code; the first one may
  // still read as pending for a moment after the submit.
  const otpRequest = await waitRequest(api, dm, ['login'], 240_000, [request.id]).catch(() => null);
  if (otpRequest) {
    const otpCard = page.getByTestId('bots-request-card').last();
    await otpCard.waitFor();
    await otpCard.getByLabel(/验证码|Code/).fill(totp(DEMO.totp));
    await otpCard.getByRole('button', { name: /提交验证码|Submit code/ }).click();
  }
  await waitIdle(api, dm, 300_000);
  await snap(page, '11-secure-login-done', { wait: 1500 });
});

await step('task', async () => {
  await ensureBots();
  const dm = state.sage.dm_session_id;
  await openConversation(page, dm);
  await send(
    page,
    '在后台帮我依次打开 https://gvisor.dev 、https://playwright.dev 、https://novnc.com ，每个用一句话总结它是做什么的，做完在这里告诉我。',
  );
  const request = await waitRequest(api, dm, ['task_start'], 240_000);
  const card = page.getByTestId('bots-request-card').last();
  await card.waitFor();
  await snap(page, '12-task-card', { wait: 600 });
  await card.getByRole('button', { name: /^开始$|^Start$/ }).click();
  await page
    .getByTestId('bots-task-dock')
    .waitFor({ timeout: 30_000 })
    .catch(() => {});
  await snap(page, '13-task-dock', { wait: 2000 });
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const { tasks } = await api('GET', `/api/bots/conversations/${dm}/tasks`);
    const task = tasks[0];
    if (task && ['succeeded', 'failed', 'canceled', 'interrupted'].includes(task.status)) break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  await page.waitForTimeout(4000);
  await openConversation(page, dm);
  // Lead with the report card's header (who reports, on which task, outcome).
  const report = page.getByTestId('bots-task-report').last();
  await report.waitFor({ timeout: 30_000 });
  await report.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await snap(page, '14-task-report', { wait: 1500 });
  void request;
});

await step('profile', async () => {
  await ensureBots();
  await openConversation(page, state.ivy.dm_session_id);
  await page.getByTestId('bots-conversation-header').getByRole('button').first().click();
  await page.getByTestId('bots-profile-drawer').waitFor({ timeout: 10_000 });
  await snap(page, '15-profile-drawer', { wait: 800 });
  await page.keyboard.press('Escape');
  await openConversation(page, state.group);
  await page.getByTestId('bots-info-button').click();
  await page.getByTestId('bots-info-panel').waitFor();
  await snap(page, '16-info-panel', { wait: 800 });
});

// ─── The computer as a computer (image contract 2) ──────

async function openComputerTab(target, key) {
  await openComputerPane(target);
  await target.getByTestId(`computer-tab-${key}`).click();
}

/** A PNG of the whole remote desktop, straight from the container (what the viewer shows). */
function desktopPng(container, name) {
  const png = execFileSync(
    'docker',
    [
      'exec',
      '-u',
      'browser',
      '-e',
      'DISPLAY=:0',
      '-e',
      'XAUTHORITY=/home/browser/.Xauthority',
      container,
      'import',
      '-window',
      'root',
      'png:-',
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  writeFileSync(resolve(OUT, `${name}.png`), png);
  log(`  📸 ${name}`);
}

await step('desktop', async () => {
  await ensureBots();
  await api('POST', '/api/bots/computer/start');
  const container = computerContainer(me.id);
  if (!container) throw new Error('the member has no running computer');
  await openConversation(page, state.ivy.dm_session_id);
  await openComputerPane(page);
  await waitScreen(page);
  await snap(page, '19-desktop-taskbar', { wait: 1200 });
  // The trial's blank screen: minimise the browser the way Chromium's own button does…
  spawnSync('docker', [
    'exec',
    '-u',
    'browser',
    '-e',
    'DISPLAY=:0',
    '-e',
    'XAUTHORITY=/home/browser/.Xauthority',
    container,
    'sh',
    '-c',
    'for w in $(xdotool search --onlyvisible --class chromium); do xdotool windowminimize "$w"; done',
  ]);
  await page.waitForTimeout(700);
  desktopPng(container, '19b-minimised');
  // …and the watchdog brings it back within a few seconds.
  await page.waitForTimeout(5000);
  desktopPng(container, '19c-restored');
});

await step('terminal', async () => {
  await ensureBots();
  await openConversation(page, state.ivy.dm_session_id);
  await openComputerTab(page, 'terminal');
  const terminal = page.getByTestId('computer-terminal');
  await terminal.waitFor({ timeout: 30_000 });
  await page.waitForTimeout(2500);
  await terminal.click();
  await page.keyboard.type(
    'clear; whoami; python3 --version; node --version; pip --version | cut -c1-30; ffmpeg -version | head -1 | cut -c1-40; ls ~/work | head -5',
  );
  await page.keyboard.press('Enter');
  await snap(page, '20-terminal', { wait: 3500 });
});

await step('files', async () => {
  await ensureBots();
  await openConversation(page, state.ivy.dm_session_id);
  await openComputerTab(page, 'files');
  await page.getByTestId('computer-file-list').waitFor({ timeout: 30_000 });
  await page.getByTestId('computer-files-input').setInputFiles({
    name: '采购清单-十月.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('品类,数量,预算\n办公用品,12,3600\n显示器,6,8940\n', 'utf8'),
  });
  await page
    .getByTestId('computer-file-row')
    .filter({ hasText: '采购清单-十月.csv' })
    .first()
    .waitFor({ timeout: 30_000 });
  await snap(page, '21-files', { wait: 1200 });
});

await step('processes', async () => {
  await ensureBots();
  const dm = state.basil.dm_session_id;
  await openConversation(page, dm);
  await send(
    page,
    '在电脑上用后台进程跑一个约 60 秒的任务：每 5 秒打印一行「第 N 步完成」，名字叫「演示进度」。启动后告诉我进程编号就行，不用等它跑完。',
  );
  await waitIdle(api, dm, 240_000);
  await openComputerTab(page, 'processes');
  const row = page.getByTestId('computer-process-row').first();
  await row.waitFor({ timeout: 30_000 });
  await row.click();
  await page.getByTestId('computer-process-log-text').waitFor({ timeout: 20_000 });
  await snap(page, '22-processes', { wait: 6000 });
});

await step('human-check', async () => {
  await ensureBots();
  await api('POST', '/api/bots/computer/start');
  const container = computerContainer(me.id);
  if (!container) throw new Error('the member has no running computer');
  startDemoSite(container);
  const dm = state.basil.dm_session_id;
  await openConversation(page, dm);
  await send(page, '打开 http://localhost:8000/verify.html ，进去后告诉我九月公开报表的订单合计金额。');
  const request = await waitRequest(api, dm, ['takeover'], 240_000);
  const card = page.getByTestId('bots-human-check').last();
  await card.waitFor({ timeout: 30_000 });
  await card.locator('canvas').first().waitFor({ timeout: 45_000 });
  await snap(page, '23-human-check-card', { wait: 2500 });
  // The member does the step on the embedded screen (the fixture's box: Tab,
  // Space), then hands back from the card, which wakes the Bot.
  await page.getByTestId('bots-request-verify-here').last().click();
  await page
    .waitForFunction(
      () =>
        document.querySelector('[data-testid="bots-human-check"]:last-of-type')?.getAttribute('data-in-control') ===
        'true',
      null,
      { timeout: 20_000 },
    )
    .catch(() => {});
  const canvas = card.locator('canvas').first();
  await canvas.click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('Tab');
  await page.keyboard.press('Space');
  await page.waitForTimeout(3000);
  await snap(page, '23b-human-check-in-control', { wait: 500 });
  await page
    .getByTestId('bots-request-card')
    .filter({ has: page.getByTestId('bots-human-check') })
    .last()
    .getByRole('button', { name: /完成，交还|I'm done/ })
    .click();
  void request;
  await waitIdle(api, dm, 300_000);
  await openConversation(page, dm);
  await snap(page, '24-human-check-passed', { wait: 1500 });
});

await step('interrupt', async () => {
  await ensureBots();
  const dm = state.sage.dm_session_id;
  await openConversation(page, dm);
  await send(
    page,
    '在电脑上依次打开 https://gvisor.dev 、https://playwright.dev 、https://novnc.com 、https://www.tmux.org ，每个读一下首页再各写两句介绍。',
  );
  await page.getByTestId('bots-live-segment').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(6000);
  await send(page, '先停一下：直接用一句话告诉我 tmux 是做什么的。');
  const handleNow = page.getByTestId('bots-pending-handle-now').last();
  await handleNow.waitFor({ timeout: 20_000 });
  await snap(page, '25-handle-now', { wait: 600 });
  await handleNow.click();
  await waitIdle(api, dm, 300_000);
  await openConversation(page, dm);
  await snap(page, '26-interrupted', { wait: 1500 });
});

await step('admin', async () => {
  const adminPage = await newPage();
  await loginUi(adminPage, ADMIN);
  await adminPage.goto(`${BASE}/#/administration/bot-computers`);
  await adminPage.getByTestId('bot-computers-runtime').waitFor({ timeout: 20_000 });
  await snap(adminPage, '17-admin-computers', { wait: 1200 });
  await adminPage.context().close();
});

await step('mobile', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', isMobile: true });
  const mobile = await context.newPage();
  await loginUi(mobile, MEMBER);
  await mobile.goto(`${BASE}/#/bots?c=${state.group ?? state.ivy.dm_session_id}`);
  await mobile.getByTestId('bots-transcript').waitFor({ timeout: 30_000 });
  await snap(mobile, '18-mobile', { wait: 1500 });
  await context.close();
});

await step('video', async () => {
  await ensureBots();
  if (NO_VIDEO) return;
  rmSync(resolve(OUT, 'video-raw'), { recursive: true, force: true });
  const videoPage = await newPage(true);
  await loginUi(videoPage, MEMBER);
  const dm = state.ivy.dm_session_id;
  await openConversation(videoPage, dm);
  await openComputerPane(videoPage);
  await waitScreen(videoPage);
  await send(videoPage, '打开必应搜索「noVNC」，点进官网，告诉我它是做什么的。');
  await waitIdle(api, dm, 240_000);
  await videoPage.getByTestId('computer-take-over').click();
  await videoPage.getByTestId('computer-hand-back').waitFor({ timeout: 20_000 });
  await videoPage.waitForTimeout(2500);
  await videoPage.getByTestId('computer-hand-back').click();
  await videoPage.waitForTimeout(2500);
  const video = videoPage.video();
  await videoPage.context().close();
  const raw = await video.path();
  const mp4 = resolve(OUT, 'bots-tour.mp4');
  const gif = resolve(OUT, 'bots-tour.gif');
  spawnSync('ffmpeg', [
    '-y',
    '-i',
    raw,
    '-vf',
    'scale=1280:-2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    mp4,
  ]);
  spawnSync('ffmpeg', ['-y', '-i', raw, '-vf', 'fps=6,scale=960:-1:flags=lanczos', gif]);
  log(`  🎬 ${mp4}`);
});

await browser.close();

// PNG → WebP for the report (lighter); keep the PNGs.
if (spawnSync('which', ['cwebp']).status === 0) {
  for (const file of readdirSync(OUT).filter((f) => f.endsWith('.png'))) {
    spawnSync('cwebp', ['-q', '82', resolve(OUT, file), '-o', resolve(OUT, file.replace(/\.png$/, '.webp'))]);
  }
}
// The raw recording is only an ffmpeg input (bots-tour.mp4/.gif are the outputs).
rmSync(resolve(OUT, 'video-raw'), { recursive: true, force: true });

console.log('\n── Summary ──');
for (const r of report) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.error ? `  ${r.error}` : ''}`);
if (diag?.issues.length) console.log('\nIssues seen:\n' + [...new Set(diag.issues)].join('\n'));
process.exit(report.some((r) => !r.ok) ? 1 : 0);
