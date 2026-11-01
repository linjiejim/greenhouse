#!/usr/bin/env node
/**
 * Product captures of a running Greenhouse 4.x instance, for the README and the website.
 *
 * Signs in as the seeded super admin, adds a little demo content over the API (a Tables base,
 * skills, a custom agent, a report template, an MCP machine client), asks the real model two
 * questions, then walks the universal client and writes WebP screenshots plus a short chat
 * recording (MP4 + poster) to docs/assets/screens/. Every step records console errors and failed
 * /api requests, so a run doubles as a smoke check. Never mock or hand-edit the results.
 *
 * Prerequisites: an instance on CAPTURE_BASE_URL (default http://localhost:18950) serving the
 * hosted client (`pnpm app:build`), a fresh database with `pnpm seed`, a working LLM in Runtime
 * Config or .env, and GREENHOUSE_EXTENSIONS listing the plugins to show (Projects, Reports and
 * Example included). Needs ffmpeg and cwebp on PATH.
 *
 *   node scripts/capture-screens.mjs                  # everything
 *   node scripts/capture-screens.mjs --only home,admin # selected steps (login and seed always run)
 *   node scripts/capture-screens.mjs --no-video
 */

import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = (process.env.CAPTURE_BASE_URL || 'http://localhost:18950').replace(/\/+$/, '');
const OUT = resolve(process.cwd(), 'docs/assets/screens');
const RAW = resolve(process.cwd(), '.work/captures');
const ACCOUNT = { email: 'maya@greenhouse.example', password: 'greenhouse' };
const args = process.argv.slice(2);
const NO_VIDEO = args.includes('--no-video');
const ONLY = (() => {
  const i = args.indexOf('--only');
  return i >= 0 ? new Set(args[i + 1].split(',')) : null;
})();
const KNOWLEDGE_QUESTION =
  'What is our home office stipend and what are the core working hours? Cite the policy document.';
const TABLES_QUESTION =
  'In the Customer Feedback base, which feedback is negative, and what is the average score per channel? Answer with a table and a bar chart.';
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

mkdirSync(OUT, { recursive: true });
mkdirSync(RAW, { recursive: true });
const report = [];

function attachDiagnostics(page) {
  const issues = [];
  page.on('console', (m) => {
    if (m.type() === 'error') issues.push(`console: ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => issues.push(`pageerror: ${String(e).slice(0, 200)}`));
  page.on('response', (r) => {
    if (r.status() >= 400 && r.url().includes('/api/'))
      issues.push(`${r.request().method()} ${r.url().replace(BASE, '')} → ${r.status()}`);
  });
  return issues;
}

async function settle(page, ms = 800) {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(ms);
}

async function snap(page, name) {
  await settle(page);
  await page.screenshot({ path: join(RAW, `${name}.png`) });
  console.log(`  ✓ ${name}`);
}

async function step(name, issues, fn) {
  if (ONLY && !ONLY.has(name)) return;
  console.log(`▸ ${name}`);
  const before = issues.length;
  try {
    await fn();
    report.push({ step: name, ok: true, issues: issues.slice(before) });
  } catch (error) {
    console.log(`  ✗ ${String(error).split('\n')[0]}`);
    report.push({ step: name, ok: false, error: String(error).slice(0, 300), issues: issues.slice(before) });
  }
}

function api(request, token) {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const call = async (method, path, data) => {
    const r = await request.fetch(`${BASE}${path}`, { method, headers, data });
    return { status: r.status(), body: await r.json().catch(() => null) };
  };
  return {
    get: (path) => call('GET', path),
    post: (path, data) => call('POST', path, data),
    put: (path, data) => call('PUT', path, data),
    patch: (path, data) => call('PATCH', path, data),
    delete: (path) => call('DELETE', path),
  };
}

async function signIn(page) {
  await page.goto(`${BASE}/login`);
  await page.getByTestId('login-email').fill(ACCOUNT.email);
  await page.getByTestId('login-password').fill(ACCOUNT.password);
  await page.getByTestId('login-submit').click();
  await page.getByTestId('composer-input').filter({ visible: true }).first().waitFor({ timeout: 30000 });
}

async function accessToken(page) {
  return page.evaluate(
    () => Object.entries(localStorage).find(([key]) => key.startsWith('greenhouse_access_token'))?.[1] ?? '',
  );
}

/** The reply is done when the stop button is gone and the transcript stops changing. */
async function waitForAnswer(page, mustContain, timeoutMs = 180000) {
  const t0 = Date.now();
  let previous = '';
  let stable = 0;
  while (Date.now() - t0 < timeoutMs) {
    await page.waitForTimeout(2000);
    const streaming = (await page.getByTestId('composer-stop').filter({ visible: true }).count()) > 0;
    const text = await page
      .getByTestId('client-main')
      .innerText()
      .catch(() => '');
    stable = text === previous ? stable + 1 : 0;
    previous = text;
    if (!streaming && stable >= 2 && mustContain.every((s) => text.includes(s))) return true;
  }
  throw new Error(`answer did not settle with ${mustContain.join(', ')}`);
}

async function ask(page, question, mustContain) {
  await page.goto(`${BASE}/`);
  const input = page.getByTestId('composer-input').filter({ visible: true }).first();
  await input.fill(question);
  await page.getByTestId('composer-send').filter({ visible: true }).click();
  await page.waitForURL(/\/chat/, { timeout: 30000 });
  await waitForAnswer(page, mustContain);
  return page.url();
}

// ─── Demo content (idempotent) ───────────────────────────

async function seedTables(client, users) {
  const bases = await client.get('/api/tables/bases');
  const existing = (bases.body?.bases ?? []).find((b) => b.name === 'Customer Feedback');
  if (existing) return existing.id;
  const created = await client.post('/api/tables/bases', {
    name: 'Customer Feedback',
    description: 'Feedback from support tickets, sales calls and the NPS survey',
    visibility: 'team',
    defaultTableName: 'Feedback',
  });
  if (created.status !== 201) throw new Error(`createBase ${created.status}: ${JSON.stringify(created.body)}`);
  const tableId = created.body.schema.table.id;
  const primary = created.body.schema.fields[0];
  const ids = {};
  const addField = async (name, type, config) => {
    const r = await client.post(`/api/tables/tables/${tableId}/fields`, { name, type, ...(config ? { config } : {}) });
    if (r.status !== 201) throw new Error(`createField ${name} ${r.status}: ${JSON.stringify(r.body)}`);
    ids[name] = r.body.field.id;
  };
  const options = (...labels) => ({
    options: labels.map((label) => ({ id: label.toLowerCase().replace(/\W+/g, '-'), label })),
  });
  await addField('Channel', 'single_select', options('Support', 'Sales call', 'NPS survey', 'Community'));
  await addField('Sentiment', 'single_select', options('Positive', 'Neutral', 'Negative'));
  await addField('Score', 'number');
  await addField('Received', 'date');
  await addField('Summary', 'long_text');
  await addField('Owner', 'user');
  await addField('Follow-up done', 'boolean');
  const owner = (email) => users.find((u) => u.email === email)?.id ?? users[0]?.id;
  const rows = [
    [
      'Acme Analytics',
      'support',
      'negative',
      4,
      '2026-10-02',
      'Dashboard export times out on large date ranges.',
      'leo',
      false,
    ],
    [
      'Northwind Retail',
      'sales-call',
      'positive',
      9,
      '2026-10-03',
      'Loved the self-serve dashboards demo; asked for SSO pricing.',
      'priya',
      true,
    ],
    [
      'Globex Health',
      'nps-survey',
      'neutral',
      7,
      '2026-10-04',
      'Wants scheduled PDF reports for the leadership team.',
      'priya',
      false,
    ],
    [
      'Initech Labs',
      'community',
      'positive',
      8,
      '2026-10-05',
      'Shared a tutorial on funnel charts in the forum.',
      'sam',
      true,
    ],
    [
      'Umbrella Foods',
      'support',
      'negative',
      3,
      '2026-10-08',
      'Alert emails arrive twice; asked for a fix date.',
      'leo',
      false,
    ],
    [
      'Vandelay Imports',
      'sales-call',
      'neutral',
      6,
      '2026-10-09',
      'Comparing us with two competitors; needs a security packet.',
      'priya',
      false,
    ],
    [
      'Stark Industries',
      'nps-survey',
      'positive',
      10,
      '2026-10-10',
      'Promoter, happy to be a reference customer.',
      'sam',
      true,
    ],
    [
      'Wayne Enterprises',
      'support',
      'neutral',
      6,
      '2026-10-11',
      'Asked how to bulk-import records into Tables.',
      'leo',
      true,
    ],
    [
      'Hooli',
      'nps-survey',
      'negative',
      5,
      '2026-10-14',
      'Onboarding emails felt generic; wants a named contact.',
      'sam',
      false,
    ],
    [
      'Soylent Co',
      'sales-call',
      'positive',
      9,
      '2026-10-15',
      'Signed the annual plan after the security review.',
      'priya',
      true,
    ],
  ];
  for (const [name, channel, sentiment, score, received, summary, who, done] of rows) {
    const values = {
      [primary.id]: name,
      [ids.Channel]: channel,
      [ids.Sentiment]: sentiment,
      [ids.Score]: score,
      [ids.Received]: received,
      [ids.Summary]: summary,
      [ids.Owner]: owner(`${who}@greenhouse.example`),
      [ids['Follow-up done']]: done,
    };
    const r = await client.post(`/api/tables/tables/${tableId}/records`, { values });
    if (r.status !== 201) throw new Error(`createRecord ${r.status}: ${JSON.stringify(r.body)}`);
  }
  return created.body.base.id;
}

async function seedSkills(client) {
  const names = new Set(((await client.get('/api/skills')).body?.skills ?? []).map((s) => s.name));
  const skills = [
    [
      'meeting-notes',
      'Meeting notes',
      'Turn a transcript or rough notes into decisions, owners and follow-ups.',
      ['writing', 'ops'],
    ],
    [
      'release-notes',
      'Release notes',
      'Draft customer-facing release notes from merged changes, grouped by benefit.',
      ['writing', 'product'],
    ],
    [
      'churn-review',
      'Churn review',
      'Review a lost customer step by step and propose one concrete save action.',
      ['customers'],
    ],
  ];
  for (const [name, display_name, description, tags] of skills) {
    if (names.has(name)) continue;
    const r = await client.post('/api/skills/publish', {
      name,
      display_name,
      description,
      tags,
      version: '1.0.0',
      changelog: 'First version.',
      files: [
        {
          path: 'SKILL.md',
          content: `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${display_name}\n\n${description}\n`,
        },
      ],
    });
    if (r.status >= 300) console.log(`  ⚠ publish ${name} ${r.status}`);
  }
}

async function seedAgent(client) {
  const custom = (await client.get('/api/profiles/custom')).body?.profiles ?? [];
  if (custom.some((p) => p.name === 'Support Triage')) return;
  const r = await client.post('/api/profiles/custom', {
    name: 'Support Triage',
    description: 'Reads new customer feedback, checks the policy docs and drafts a reply for the owner.',
    base_profile_id: 'sprouty',
    system_prompt:
      'You triage customer feedback for the support team. Read the newest negative feedback, check the knowledge base for the relevant policy, and draft a reply the owner can send as-is. Never promise a date that is not in a project plan.',
  });
  if (r.status >= 300) console.log(`  ⚠ custom agent ${r.status}: ${JSON.stringify(r.body).slice(0, 160)}`);
}

async function seedMachineClient(client, users) {
  const list = await client.get('/api/admin/platform/oauth/clients');
  if ((list.body?.clients ?? []).some((c) => c.client_name === 'Claude Desktop (Maya)')) return;
  const maya = users.find((u) => u.email === ACCOUNT.email);
  const r = await client.post('/api/admin/platform/oauth/machine-clients', {
    client_name: 'Claude Desktop (Maya)',
    bound_user_id: maya?.id,
    scopes: ['mcp:read'],
  });
  if (r.status >= 300) console.log(`  ⚠ machine client ${r.status}: ${JSON.stringify(r.body).slice(0, 160)}`);
}

// ─── Tour ────────────────────────────────────────────────

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 2, colorScheme: 'light' });
const page = await context.newPage();
const issues = attachDiagnostics(page);
const shots = {};

await signIn(page);
const token = await accessToken(page);
const client = api(page.request, token);
await client.put('/api/auth/me/preferences', { locale: 'en' });
const users = (await client.get('/api/admin/users')).body?.users ?? [];

await step('seed', issues, async () => {
  await seedTables(client, users);
  await seedSkills(client);
  await seedAgent(client);
  await seedMachineClient(client, users);
});

await page.reload();
await page.getByTestId('composer-input').filter({ visible: true }).first().waitFor();

await step('home', issues, async () => {
  await page.goto(`${BASE}/`);
  await snap(page, 'home');
});

await step('chat', issues, async () => {
  shots.knowledgeChat = await ask(page, KNOWLEDGE_QUESTION, ['stipend']);
  await snap(page, 'chat-knowledge-answer');
});

await step('chat-tables', issues, async () => {
  shots.tablesChat = await ask(page, TABLES_QUESTION, ['Support']);
  await snap(page, 'chat-tables-answer');
});

await step('knowledge', issues, async () => {
  await page.goto(`${BASE}/knowledge`);
  await settle(page);
  await page
    .getByText(/handbook|Remote/i)
    .first()
    .click()
    .catch(() => {});
  await snap(page, 'knowledge');
});

await step('drive', issues, async () => {
  await page.goto(`${BASE}/drive`);
  await settle(page);
  if ((await page.getByText('Q4 launch plan.md').count()) === 0) {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Upload' }).first().click();
    await (
      await chooser
    ).setFiles([
      {
        name: 'Q4 launch plan.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from('# Q4 launch plan\n\n- Beta in October\n- GA in November\n'),
      },
      {
        name: 'Customer interviews.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('company,score,quote\nAcme,4,Exports time out\nStark,10,Happy to be a reference\n'),
      },
      { name: 'Greenhouse logo.png', mimeType: 'image/png', buffer: readFileSync('logos/greenhouse-logo.png') },
      {
        name: 'Pricing notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Annual plan: 2 months free. SSO on Business and up.\n'),
      },
    ]);
    await page.getByText('Q4 launch plan.md').first().waitFor({ timeout: 30000 });
  }
  await snap(page, 'files');
});

await step('tables', issues, async () => {
  await page.goto(`${BASE}/drive?view=tables`);
  await page.getByText('Acme Analytics').first().waitFor({ timeout: 20000 });
  await snap(page, 'tables-grid');
});

await step('projects', issues, async () => {
  await page.goto(`${BASE}/projects`);
  await settle(page);
  await page.getByText('Q3 Product Launch').first().click();
  await snap(page, 'projects-board');
  await page.getByText('Gantt', { exact: true }).first().click();
  await snap(page, 'projects-gantt');
});

await step('automations', issues, async () => {
  await page.goto(`${BASE}/automations`);
  await settle(page);
  if (
    await page
      .getByText('No runs yet')
      .isVisible()
      .catch(() => false)
  ) {
    await page.getByRole('button', { name: 'Run now' }).first().click();
    await page.getByText('No runs yet').waitFor({ state: 'hidden', timeout: 60000 });
    await page.waitForTimeout(90000);
    await page.goto(`${BASE}/automations`);
  }
  await snap(page, 'automations');
});

await step('plugins', issues, async () => {
  await page.goto(`${BASE}/p/example/example-embed`);
  await page.waitForTimeout(3000);
  await snap(page, 'plugin-embed');
  await page.goto(`${BASE}/me/agents`);
  await snap(page, 'my-agents');
});

await step('skills', issues, async () => {
  await page.goto(`${BASE}/p/skills/skills`);
  await snap(page, 'skills');
});

await step('admin', issues, async () => {
  for (const [section, name] of [
    ['users', 'admin-members'],
    ['activity', 'admin-activity'],
    ['services', 'admin-services'],
    ['usage', 'admin-usage'],
    ['mcp-keys', 'admin-mcp-access'],
    ['runtime-config', 'admin-runtime-config'],
    ['branding', 'admin-branding'],
  ]) {
    await page.goto(`${BASE}/admin/${section}`);
    await snap(page, name);
  }
});

await step('dark', issues, async () => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(shots.knowledgeChat ?? `${BASE}/`);
  await snap(page, 'chat-knowledge-answer-dark');
  await page.goto(`${BASE}/`);
  await snap(page, 'home-dark');
  await page.emulateMedia({ colorScheme: 'light' });
});

await step('phone', issues, async () => {
  const phone = await browser.newContext({
    viewport: PHONE,
    deviceScaleFactor: 3,
    colorScheme: 'light',
    storageState: await context.storageState(),
    isMobile: true,
    hasTouch: true,
  });
  const p = await phone.newPage();
  await p.goto(shots.knowledgeChat ?? `${BASE}/`);
  await snap(p, 'phone-web-chat');
  await phone.close();
});

await step('video', issues, async () => {
  if (NO_VIDEO) return;
  const dir = join(RAW, 'video');
  rmSync(dir, { recursive: true, force: true });
  const rec = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: 'light',
    storageState: await context.storageState(),
    recordVideo: { dir, size: { width: 1280, height: 800 } },
  });
  const p = await rec.newPage();
  await p.goto(`${BASE}/`);
  await settle(p, 1500);
  const input = p.getByTestId('composer-input').filter({ visible: true }).first();
  await input.pressSequentially(KNOWLEDGE_QUESTION, { delay: 25 });
  await p.getByTestId('composer-send').filter({ visible: true }).click();
  await waitForAnswer(p, ['stipend']);
  await p.waitForTimeout(2500);
  await rec.close();
  const webm = readdirSync(dir).find((f) => f.endsWith('.webm'));
  renameSync(join(dir, webm), join(RAW, 'chat-knowledge.webm'));
});

await browser.close();

// ─── Encode ──────────────────────────────────────────────

for (const file of readdirSync(RAW).filter((f) => f.endsWith('.png'))) {
  const name = file.replace(/\.png$/, '');
  execFileSync('cwebp', [
    '-quiet',
    '-q',
    '86',
    '-resize',
    name.startsWith('phone') ? '780' : '1440',
    '0',
    join(RAW, file),
    '-o',
    join(OUT, `${name}.webp`),
  ]);
}
if (existsSync(join(RAW, 'chat-knowledge.webm'))) {
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-i',
    join(RAW, 'chat-knowledge.webm'),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '26',
    '-movflags',
    '+faststart',
    '-an',
    join(OUT, 'chat-knowledge.mp4'),
  ]);
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-sseof',
    '-1',
    '-i',
    join(OUT, 'chat-knowledge.mp4'),
    '-frames:v',
    '1',
    join(RAW, 'chat-knowledge-poster.png'),
  ]);
  execFileSync('cwebp', [
    '-quiet',
    '-q',
    '86',
    join(RAW, 'chat-knowledge-poster.png'),
    '-o',
    join(OUT, 'chat-knowledge-poster.webp'),
  ]);
}

console.log('\nReport');
for (const r of report) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.step}${r.error ? ` — ${r.error.split('\n')[0]}` : ''}`);
  for (const issue of r.issues) console.log(`    ${issue}`);
}
process.exitCode = report.some((r) => !r.ok) ? 1 : 0;
