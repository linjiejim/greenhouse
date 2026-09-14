#!/usr/bin/env node
/**
 * Screenshot + smoke tour of a running Greenhouse instance.
 *
 * Logs in as the seeded super admin, seeds a little demo content over the API
 * (a Tables base, a Home workbench layout, two skills, one automation run),
 * walks every major surface, and writes screenshots (WebP, plus a short chat
 * video → gif/mp4) into docs/assets/screens/. Every step records console errors
 * and failed /api requests, so the run doubles as an end-to-end smoke check.
 *
 * Prerequisites: a dev stack on E2E_BASE_URL (default http://localhost:4400)
 * with the example dataset loaded (`pnpm seed`); ffmpeg (gif/mp4) and cwebp
 * (png → webp) on PATH — each is skipped with a warning when missing.
 *
 *   node scripts/capture-screens.mjs            # light theme, all surfaces
 *   node scripts/capture-screens.mjs --no-video # skip the chat recording
 *   node scripts/capture-screens.mjs --only chat,knowledge   # login + webp always run
 *   node scripts/capture-screens.mjs --only seed,chat --cleanup  # also drop earlier tour sessions
 */

import { chromium } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:4400';
const OUT = resolve(process.cwd(), 'docs/assets/screens');
const ACCOUNT = { email: 'maya@greenhouse.example', password: 'greenhouse' };
const args = process.argv.slice(2);
const NO_VIDEO = args.includes('--no-video');
const FORCE_CLEANUP = args.includes('--cleanup');
const ONLY = (() => {
  const i = args.indexOf('--only');
  return i >= 0 ? new Set(args[i + 1].split(',')) : null;
})();
const KNOWLEDGE_QUESTION =
  'What is our home office stipend and what are the core working hours? Cite the policy document.';
const TABLES_QUESTION =
  'Look at the Customer Feedback base in Tables: which feedback is negative, and what is the average score per channel? Show a table.';

mkdirSync(OUT, { recursive: true });

const report = [];
function log(msg) {
  console.log(msg);
}

// ─── Helpers ────────────────────────────────────────────

function attachDiagnostics(page, label) {
  const issues = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !/502|ERR_CONNECTION/.test(m.text())) issues.push(`console: ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => issues.push(`pageerror: ${String(e).slice(0, 200)}`));
  page.on('response', (r) => {
    const url = r.url();
    if (r.status() >= 400 && url.includes('/api/'))
      issues.push(`${r.request().method()} ${url.replace(BASE, '')} → ${r.status()}`);
  });
  return { label, issues };
}

async function settle(page, ms = 700) {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(ms);
}

/** Fresh contexts start in the light theme; the dark-theme step overrides the key and reloads. */
function themeInit() {
  if (!localStorage.getItem('greenhouse-theme')) localStorage.setItem('greenhouse-theme', 'light');
}

/** Toasts ("automation completed", …) drift into captures — hide them in the tour contexts. */
function hideToastsInit() {
  document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = '.fixed.z-\\[100\\].pointer-events-none{display:none!important}';
    document.head.appendChild(style);
  });
}

/** Click the first candidate locator that exists on the page. */
async function clickFirst(page, candidates) {
  for (const make of candidates) {
    const loc = make(page);
    if ((await loc.count().catch(() => 0)) > 0) {
      await loc.first().click();
      return true;
    }
  }
  return false;
}

async function snap(page, name, opts = {}) {
  await settle(page, opts.wait ?? 700);
  const file = resolve(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false, ...(opts.clip ? { clip: opts.clip } : {}) });
  log(`  📸 ${name}`);
}

async function step(name, fn) {
  // login and the webp pass always run; --only filters the tour steps in between.
  if (ONLY && !ONLY.has(name) && name !== 'login' && name !== 'webp') return;
  log(`▶ ${name}`);
  try {
    await fn();
    report.push({ name, ok: true });
  } catch (err) {
    report.push({ name, ok: false, error: String(err).slice(0, 300) });
    log(`  ✗ ${name}: ${String(err).slice(0, 300)}`);
  }
}

async function login(page) {
  await page.goto(`${BASE}/`);
  await page.getByTestId('login-email').fill(ACCOUNT.email);
  await page.getByTestId('login-password').fill(ACCOUNT.password);
  await page.getByTestId('login-submit').click();
  await page.getByTestId('chat-input').waitFor({ timeout: 30000 });
}

async function accessToken(page) {
  return page.evaluate(() => localStorage.getItem('greenhouse_access_token'));
}

function api(request, token) {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  return {
    async get(path) {
      const r = await request.get(`${BASE}${path}`, { headers });
      return { status: r.status(), body: await r.json().catch(() => null) };
    },
    async post(path, data) {
      const r = await request.post(`${BASE}${path}`, { headers, data });
      return { status: r.status(), body: await r.json().catch(() => null) };
    },
    async put(path, data) {
      const r = await request.put(`${BASE}${path}`, { headers, data });
      return { status: r.status(), body: await r.json().catch(() => null) };
    },
    async delete(path) {
      const r = await request.delete(`${BASE}${path}`, { headers });
      return { status: r.status(), body: await r.json().catch(() => null) };
    },
  };
}

/**
 * Wait until the assistant finished answering: the stop button is gone, the expected
 * strings are on screen, and the transcript has stopped changing for two polls (the
 * stop button briefly disappears between tool steps, so text stability is the real signal).
 */
async function waitForAnswer(page, mustContain, timeoutMs = 150000) {
  const t0 = Date.now();
  let previous = '';
  let stablePolls = 0;
  while (Date.now() - t0 < timeoutMs) {
    await page.waitForTimeout(2000);
    const stop = await page
      .getByLabel('Stop generating')
      .isVisible()
      .catch(() => false);
    const text = await page
      .locator('main')
      .innerText()
      .catch(() => '');
    stablePolls = text === previous ? stablePolls + 1 : 0;
    previous = text;
    if (!stop && stablePolls >= 2 && mustContain.every((s) => text.includes(s))) return true;
  }
  return false;
}

// ─── Demo content (idempotent) ───────────────────────────

async function seedTables(client, users) {
  const bases = await client.get('/api/tables/bases');
  const existing = (bases.body?.bases ?? []).find((b) => b.name === 'Customer Feedback');
  if (existing) {
    const detail = await client.get(`/api/tables/bases/${existing.id}`);
    return { baseId: existing.id, tableId: detail.body?.tables?.[0]?.id };
  }
  const created = await client.post('/api/tables/bases', {
    name: 'Customer Feedback',
    description: 'Feedback collected from support tickets, sales calls and the NPS survey',
    visibility: 'team',
    defaultTableName: 'Feedback',
  });
  if (created.status !== 201) throw new Error(`createBase ${created.status}: ${JSON.stringify(created.body)}`);
  const baseId = created.body.base.id;
  const tableId = created.body.schema.table.id;
  const primary = created.body.schema.fields[0];
  const byName = {};
  const addField = async (name, type, config) => {
    const r = await client.post(`/api/tables/tables/${tableId}/fields`, { name, type, ...(config ? { config } : {}) });
    if (r.status !== 201) throw new Error(`createField ${name} ${r.status}: ${JSON.stringify(r.body)}`);
    byName[name] = r.body.field.id;
  };
  await addField('Channel', 'single_select', {
    options: [
      { id: 'support', label: 'Support' },
      { id: 'sales', label: 'Sales call' },
      { id: 'nps', label: 'NPS survey' },
      { id: 'community', label: 'Community' },
    ],
  });
  await addField('Sentiment', 'single_select', {
    options: [
      { id: 'positive', label: 'Positive' },
      { id: 'neutral', label: 'Neutral' },
      { id: 'negative', label: 'Negative' },
    ],
  });
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
      '2026-09-02',
      'Dashboard export times out on large date ranges.',
      'leo@greenhouse.example',
      false,
    ],
    [
      'Northwind Retail',
      'sales',
      'positive',
      9,
      '2026-09-03',
      'Loved the self-serve dashboards demo; asked for SSO pricing.',
      'priya@greenhouse.example',
      true,
    ],
    [
      'Globex Health',
      'nps',
      'neutral',
      7,
      '2026-09-04',
      'Wants scheduled PDF reports for the leadership team.',
      'priya@greenhouse.example',
      false,
    ],
    [
      'Initech Labs',
      'community',
      'positive',
      8,
      '2026-09-05',
      'Shared a tutorial on funnel charts in the forum.',
      'sam@greenhouse.example',
      true,
    ],
    [
      'Umbrella Foods',
      'support',
      'negative',
      3,
      '2026-09-08',
      'Alert emails arrive twice; asked for a fix ETA.',
      'leo@greenhouse.example',
      false,
    ],
    [
      'Vandelay Imports',
      'sales',
      'neutral',
      6,
      '2026-09-09',
      'Comparing us with two competitors; needs a security packet.',
      'priya@greenhouse.example',
      false,
    ],
    [
      'Stark Industries',
      'nps',
      'positive',
      10,
      '2026-09-10',
      'Promoter — happy to be a reference customer.',
      'sam@greenhouse.example',
      true,
    ],
    [
      'Wayne Enterprises',
      'support',
      'neutral',
      6,
      '2026-09-11',
      'Asked how to bulk-import records into Tables.',
      'leo@greenhouse.example',
      true,
    ],
  ];
  for (const [name, channel, sentiment, score, received, summary, ownerEmail, done] of rows) {
    const values = {
      [String(primary.id)]: name,
      [String(byName.Channel)]: channel,
      [String(byName.Sentiment)]: sentiment,
      [String(byName.Score)]: score,
      [String(byName.Received)]: received,
      [String(byName.Summary)]: summary,
      [String(byName.Owner)]: owner(ownerEmail),
      [String(byName['Follow-up done'])]: done,
    };
    const r = await client.post(`/api/tables/tables/${tableId}/records`, { values });
    if (r.status !== 201) throw new Error(`createRecord ${r.status}: ${JSON.stringify(r.body)}`);
  }
  return { baseId, tableId };
}

async function seedWorkbench(client) {
  const current = await client.get('/api/platform/me/workbench');
  const cfg = current.body?.preferences ?? current.body ?? {};
  if (Array.isArray(cfg.widgets) && cfg.widgets.length > 0) return;
  const card = (id, title, recipeId, status, layout, display = 'table') => ({
    kind: 'data',
    id,
    title,
    recipeId,
    layout: { tabId: 'default', ...layout },
    display,
    source: {
      toolId: 'project_query',
      input: status ? { action: 'list', status, limit: 15 } : { action: 'list', limit: 15 },
    },
    map: {
      rows: 'projects',
      columns: [
        { key: 'title', type: 'text' },
        { key: 'status', type: 'badge' },
      ],
    },
  });
  const body = {
    version: 2,
    appOrder: ['knowledge', 'projects', 'tables'],
    pinnedAppIds: ['knowledge', 'projects'],
    hiddenAppIds: [],
    defaultAppId: null,
    density: 'comfortable',
    tabs: [],
    widgets: [
      {
        kind: 'text',
        id: 'welcome',
        title: 'This week',
        layout: { tabId: 'default', x: 0, y: 0, w: 4, h: 4 },
        markdown:
          '**Launch week checklist**\n\n- [x] Pricing page copy\n- [x] Security packet for Vandelay\n- [ ] SOC 2 evidence review (Thu)\n- [ ] Launch blog post — draft in chat',
      },
      card('active', 'Active projects', 'projects.active', 'active', { x: 4, y: 0, w: 8, h: 4 }),
      card('planning', 'Planned projects', 'projects.planning', 'planning', { x: 0, y: 4, w: 6, h: 4 }),
      card('on_hold', 'Paused projects', 'projects.on_hold', 'on_hold', { x: 6, y: 4, w: 6, h: 4 }),
    ],
  };
  const r = await client.put('/api/platform/me/workbench', body);
  if (r.status >= 300) throw new Error(`workbench PUT ${r.status}: ${JSON.stringify(r.body)}`);
}

async function seedSkills(client) {
  const list = await client.get('/api/skills');
  const names = new Set((list.body?.skills ?? []).map((s) => s.name));
  const skills = [
    {
      name: 'meeting-notes',
      display_name: 'Meeting notes',
      description: 'Turn a raw transcript or bullet dump into decisions, owners and follow-ups.',
      tags: ['writing', 'ops'],
      body: `# Meeting notes\n\nUse this skill when the user pastes a transcript or rough notes from a meeting.\n\n## Output\n\n1. **Decisions** — one line each, past tense.\n2. **Action items** — owner, due date, and the sentence from the notes that justifies it.\n3. **Open questions** — anything discussed but not decided.\n\nKeep the original wording for numbers and dates; never invent an owner.`,
    },
    {
      name: 'release-notes',
      display_name: 'Release notes',
      description: 'Draft customer-facing release notes from merged changes, grouped by benefit.',
      tags: ['writing', 'product'],
      body: `# Release notes\n\nGiven a list of merged changes (commits, PR titles or a changelog), write release notes for customers.\n\n- Lead with the benefit, not the mechanism.\n- Group under **New**, **Improved**, **Fixed**.\n- One sentence per item; link the docs page when the user provides one.\n- Skip internal refactors unless they change behaviour.`,
    },
  ];
  for (const skill of skills) {
    if (names.has(skill.name)) continue;
    const r = await client.post('/api/skills/publish', {
      name: skill.name,
      display_name: skill.display_name,
      description: skill.description,
      tags: skill.tags,
      version: '1.0.0',
      changelog: 'Initial release.',
      files: [
        {
          path: 'SKILL.md',
          content: `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body}\n`,
        },
      ],
    });
    if (r.status >= 300) log(`  ⚠ publish ${skill.name} ${r.status}: ${JSON.stringify(r.body).slice(0, 160)}`);
  }
}

/** Drop chat sessions left behind by an earlier tour run so the sidebar stays tidy. */
async function cleanupTourSessions(client) {
  const sessions = (await client.get('/api/sessions')).body?.sessions ?? [];
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const tourTitle = (t) =>
    typeof t === 'string' &&
    (t.startsWith(KNOWLEDGE_QUESTION.slice(0, 30)) ||
      t.startsWith(TABLES_QUESTION.slice(0, 30)) ||
      t.startsWith('[Daily standup'));
  for (const s of sessions) {
    if (!tourTitle(s.title)) continue;
    if (s.created_at && Date.parse(s.created_at) < dayAgo) continue;
    await client.delete(`/api/sessions/${s.id}`);
  }
}

async function seedAgent(client) {
  const profiles = (await client.get('/api/profiles')).body?.profiles ?? [];
  if (profiles.some((p) => p.name === 'Support Triage')) return;
  const available = new Set(((await client.get('/api/tools')).body?.tools ?? []).map((t) => t.id));
  const tools = ['knowledge_search', 'knowledge_query', 'tables_query', 'project_query', 'web_search'].filter((id) =>
    available.has(id),
  );
  const r = await client.post('/api/profiles/custom', {
    name: 'Support Triage',
    description: 'Reads new customer feedback, checks the policy docs and drafts a reply for the owner to approve.',
    base_profile_id: 'sprouty',
    tools,
    system_prompt:
      'You triage customer feedback for the support team.\n\n1. Read the record the user points at (or the newest negative ones in the Customer Feedback base).\n2. Check the knowledge base for the relevant policy before answering.\n3. Draft a reply the owner can send as-is: acknowledge, state what we will do, give a date.\n\nNever promise a fix date that is not in a project plan.',
  });
  if (r.status >= 300) log(`  ⚠ custom agent ${r.status}: ${JSON.stringify(r.body).slice(0, 160)}`);
}

async function seedMachineClient(client, users) {
  const list = await client.get('/api/admin/platform/oauth/clients');
  if ((list.body?.clients ?? []).some((c) => c.client_name === 'Claude Desktop (Maya)')) return;
  const maya = users.find((u) => u.email === ACCOUNT.email);
  if (!maya) return;
  const r = await client.post('/api/admin/platform/oauth/machine-clients', {
    client_name: 'Claude Desktop (Maya)',
    bound_user_id: maya.id,
    scopes: ['mcp:read'],
  });
  if (r.status >= 300) log(`  ⚠ machine client ${r.status}: ${JSON.stringify(r.body).slice(0, 160)}`);
}

// ─── Tour ───────────────────────────────────────────────

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await context.addInitScript(themeInit);
await context.addInitScript(hideToastsInit);
const page = await context.newPage();
const diag = attachDiagnostics(page, 'tour');

await step('login', async () => {
  await page.goto(`${BASE}/`);
  await page.waitForSelector('[data-testid="login-submit"]');
  await snap(page, 'login');
  await login(page);
});

const token = await accessToken(page);
const client = api(context.request, token);
let users = [];
let tables = { baseId: null, tableId: null };

await step('seed', async () => {
  users = (await client.get('/api/admin/users')).body?.users ?? [];
  if (!ONLY || FORCE_CLEANUP) await cleanupTourSessions(client);
  tables = await seedTables(client, users);
  await seedWorkbench(client);
  await seedSkills(client);
  await seedAgent(client);
  await seedMachineClient(client, users);
  // Kick off one automation so the execution center has something to show.
  const tasks = (await client.get('/api/tasks')).body?.tasks ?? [];
  const digest = tasks.find((t) => /standup/i.test(t.name)) ?? tasks[0];
  if (digest && !ONLY) await client.post(`/api/tasks/${digest.id}/run`, {});
});

await step('workbench', async () => {
  await page.goto(`${BASE}/#/chat`);
  await page.reload();
  await settle(page, 1500);
  await snap(page, 'home-workbench');
});

let answeredSessionUrl = null;
await step('chat', async () => {
  await page.goto(`${BASE}/#/chat`);
  await page.getByTestId('chat-input').waitFor();
  await page.getByTestId('chat-input').fill(KNOWLEDGE_QUESTION);
  await page.getByTestId('chat-input').press('Enter');
  const ok = await waitForAnswer(page, ['$1,000', '10:00']);
  if (!ok) throw new Error('assistant answer did not complete in time');
  answeredSessionUrl = page.url();
  await snap(page, 'chat-knowledge-answer', { wait: 1200 });
  await page
    .getByText(/Show all \d+ references?/)
    .click()
    .catch(() => {});
  await page
    .getByText(/Tool calls · \d+/)
    .click()
    .catch(() => {});
  await snap(page, 'chat-knowledge-trace', { wait: 1200 });
});

await step('chat-tables', async () => {
  await page.goto(`${BASE}/#/chat`);
  await page.getByTestId('chat-input').waitFor();
  // Fresh conversation so the Tables question gets its own session.
  await page
    .getByRole('button', { name: 'New Chat' })
    .first()
    .click()
    .catch(() => {});
  await page.getByTestId('chat-input').waitFor();
  await page.getByTestId('chat-input').fill(TABLES_QUESTION);
  await page.getByTestId('chat-input').press('Enter');
  const ok = await waitForAnswer(page, ['Acme'], 180000);
  if (!ok) throw new Error('tables answer did not complete in time');
  // Let the chart/table finish rendering, then frame the answer from its tool-call header.
  await settle(page, 2000);
  await page
    .getByText(/Tool calls · \d+/)
    .last()
    .evaluate((el) => el.scrollIntoView({ block: 'start' }))
    .catch(() => {});
  await page.waitForTimeout(400);
  // The "jump to latest" pill is real UI, but it would sit on top of the chart in the frame.
  await page
    .getByRole('button', { name: /Jump to latest/ })
    .evaluateAll((els) => els.forEach((el) => (el.style.visibility = 'hidden')))
    .catch(() => {});
  await snap(page, 'chat-tables-answer', { wait: 300 });
});

await step('knowledge', async () => {
  await page.goto(`${BASE}/#/knowledge/doc/2-remote-work-policy`);
  await snap(page, 'knowledge-doc', { wait: 1500 });
  await page.goto(`${BASE}/#/knowledge`);
  await settle(page);
  await page.getByPlaceholder(/Search knowledge/i).fill('stipend');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  await page
    .getByRole('button', { name: /Remote Work Policy/ })
    .first()
    .click()
    .catch(() => {});
  await snap(page, 'knowledge-search', { wait: 1500 });
});

await step('projects', async () => {
  await page.goto(`${BASE}/#/projects`);
  await settle(page, 1200);
  await page
    .getByRole('button', { name: 'Cards' })
    .click()
    .catch(() => {});
  await snap(page, 'projects-cards', { wait: 1000 });
  await page
    .getByRole('button', { name: 'Timeline' })
    .click()
    .catch(() => {});
  await page
    .getByRole('button', { name: 'Year' })
    .click()
    .catch(() => {});
  await snap(page, 'projects-gantt', { wait: 1200 });
  await page.goto(`${BASE}/#/projects/2`);
  await settle(page, 1200);
  await clickFirst(page, [
    (p) => p.getByRole('tab', { name: 'Board' }),
    (p) => p.getByRole('button', { name: 'Board' }),
    (p) => p.getByText('Board', { exact: true }),
  ]);
  await snap(page, 'project-board', { wait: 1500 });
});

await step('tables', async () => {
  if (!tables.tableId) throw new Error('no demo table');
  await page.goto(`${BASE}/#/tables/${tables.baseId}/table/${tables.tableId}`);
  await snap(page, 'tables-grid', { wait: 1800 });
});

await step('executions', async () => {
  await page.goto(`${BASE}/#/executions`);
  await settle(page, 1200);
  // Tab names carry their count ("All 2"), so match on the prefix only.
  await clickFirst(page, [(p) => p.getByRole('tab', { name: /^All/ }), (p) => p.getByRole('button', { name: /^All/ })]);
  await snap(page, 'execution-center', { wait: 1500 });
  await page.goto(`${BASE}/#/automations`);
  await snap(page, 'automations', { wait: 1200 });
  await page.goto(`${BASE}/#/tasks`);
  await snap(page, 'prompt-tasks', { wait: 1000 });
});

await step('agents', async () => {
  await page.goto(`${BASE}/#/agents`);
  await snap(page, 'agents', { wait: 1200 });
  await page.goto(`${BASE}/#/skillhub`);
  await snap(page, 'skillhub', { wait: 1500 });
});

await step('search-and-assistant', async () => {
  await page.goto(`${BASE}/#/chat`);
  await settle(page);
  await page
    .getByRole('button', { name: /Search/ })
    .first()
    .click();
  await page.keyboard.type('roadmap');
  await snap(page, 'global-search', { wait: 1500 });
  await page.keyboard.press('Escape');
  // The dialog hands focus back to the search trigger, whose tooltip would haunt the next frames.
  await page.waitForTimeout(400);
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.mouse.move(700, 450);
  await page.getByRole('button', { name: 'More', exact: true }).first().hover();
  await snap(page, 'more-menu', { wait: 800 });
  await page.mouse.move(720, 450);
});

await step('settings', async () => {
  for (const [route, name] of [
    ['settings/preferences', 'settings-preferences'],
    ['settings/memory', 'settings-memory'],
    ['settings/provider-bindings', 'settings-connections'],
    ['settings/agent-connections', 'settings-agent-connections'],
  ]) {
    await page.goto(`${BASE}/#/${route}`);
    await snap(page, name, { wait: 1000 });
  }
});

await step('administration', async () => {
  for (const [route, name] of [
    ['administration/users', 'admin-users'],
    ['administration/runtime-config', 'admin-runtime-config'],
    ['administration/branding', 'admin-branding-studio'],
    ['administration/usage', 'admin-usage'],
    ['administration/mcp-keys', 'admin-mcp-access'],
    ['administration/eval', 'admin-evaluation'],
  ]) {
    await page.goto(`${BASE}/#/${route}`);
    await snap(page, name, { wait: 1200 });
  }
  await page.goto(`${BASE}/#/administration/users`);
  await settle(page, 1000);
  const row = page.locator('tr', { hasText: 'leo@greenhouse.example' }).first();
  await row.getByRole('button', { name: 'Permissions' }).first().click();
  await snap(page, 'admin-permissions-dialog', { wait: 1500 });
  await page.keyboard.press('Escape');
});

await step('inbox', async () => {
  await page.goto(`${BASE}/#/chat`);
  await settle(page);
  // The user menu opens on hover — a click on the trigger navigates to Settings.
  await page
    .getByRole('button', { name: /Maya Chen/ })
    .first()
    .hover();
  await page.getByRole('menuitem', { name: /Inbox/ }).first().click();
  await snap(page, 'inbox', { wait: 1200 });
  await page.keyboard.press('Escape');
  await page.mouse.move(700, 450);
});

await step('extension', async () => {
  // Only meaningful when the stack runs with GREENHOUSE_EXTENSIONS=example.
  const active = (await client.get('/api/extensions')).body?.extensions ?? [];
  if (!active.some((e) => e.id === 'example')) {
    log('  ↷ example extension not active — skipped');
    return;
  }
  const notes = (await client.get('/api/ext/example/notes')).body?.notes ?? [];
  if (notes.length === 0) {
    for (const body of [
      'Ask Priya for the SOC 2 evidence list',
      'Draft the launch blog outline',
      'Renew the Vandelay security packet',
    ]) {
      await client.post('/api/ext/example/notes', { body });
    }
  }
  await page.goto(`${BASE}/#/example`);
  await snap(page, 'extension-example-page', { wait: 1500 });
  await page.getByRole('button', { name: 'More', exact: true }).first().hover();
  await snap(page, 'extension-more-menu', { wait: 800 });
  await page.mouse.move(700, 450);
  await page.goto(`${BASE}/#/settings/example`);
  await snap(page, 'extension-settings-module', { wait: 1200 });
  await page.goto(`${BASE}/#/administration/runtime-config`);
  await settle(page, 1200);
  await page
    .getByText('Example notes (extension)')
    .scrollIntoViewIfNeeded()
    .catch(() => {});
  await snap(page, 'extension-runtime-config', { wait: 800 });
  await page.goto(`${BASE}/#/chat`);
  await page.getByTestId('chat-input').waitFor();
  await page
    .getByRole('button', { name: 'New Chat' })
    .first()
    .click()
    .catch(() => {});
  await page.getByTestId('chat-input').fill('What did I note down? List my example notes.');
  await page.getByTestId('chat-input').press('Enter');
  const ok = await waitForAnswer(page, ['SOC 2'], 120000);
  if (!ok) throw new Error('extension tool answer did not complete in time');
  await snap(page, 'extension-chat-card', { wait: 1200 });
});

await step('dark-theme', async () => {
  await page.mouse.move(700, 450);
  await page.evaluate(() => localStorage.setItem('greenhouse-theme', 'dark'));
  if (answeredSessionUrl) {
    await page.goto(answeredSessionUrl);
    await page.reload();
    await snap(page, 'chat-knowledge-answer-dark', { wait: 1500 });
  }
  await page.goto(`${BASE}/#/tables/${tables.baseId}/table/${tables.tableId}`);
  await page.reload();
  await snap(page, 'tables-grid-dark', { wait: 1800 });
  await page.goto(`${BASE}/#/chat`);
  await page.reload();
  await page
    .getByRole('button', { name: 'New Chat' })
    .first()
    .click()
    .catch(() => {});
  await snap(page, 'home-workbench-dark', { wait: 1500 });
  await page.evaluate(() => localStorage.setItem('greenhouse-theme', 'light'));
});

await step('mobile', async () => {
  const state = await context.storageState();
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    storageState: state,
  });
  await mobile.addInitScript(themeInit);
  await mobile.addInitScript(hideToastsInit);
  const mp = await mobile.newPage();
  if (answeredSessionUrl) {
    await mp.goto(answeredSessionUrl);
    await settle(mp, 1500);
    await mp.screenshot({ path: resolve(OUT, 'mobile-chat.png') });
    log('  📸 mobile-chat');
  }
  await mobile.close();
});

await step('video', async () => {
  if (NO_VIDEO) return;
  const state = await context.storageState();
  const rec = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    storageState: state,
    recordVideo: { dir: resolve(OUT, '.video'), size: { width: 1280, height: 800 } },
  });
  await rec.addInitScript(themeInit);
  const vp = await rec.newPage();
  await vp.goto(`${BASE}/#/chat`);
  await vp.getByTestId('chat-input').waitFor();
  await vp.waitForTimeout(800);
  await vp.getByTestId('chat-input').type(KNOWLEDGE_QUESTION, { delay: 18 });
  await vp.waitForTimeout(400);
  await vp.getByTestId('chat-input').press('Enter');
  await waitForAnswer(vp, ['$1,000', '10:00']);
  await vp
    .getByText(/Show all \d+ references?/)
    .click()
    .catch(() => {});
  await vp.waitForTimeout(2500);
  const video = vp.video();
  await rec.close();
  const src = await video.path();
  const webm = resolve(OUT, 'chat-knowledge.webm');
  renameSync(src, webm);
  rmSync(resolve(OUT, '.video'), { recursive: true, force: true });
  const ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (ffmpeg.status !== 0) {
    log('  ⚠ ffmpeg not found — kept chat-knowledge.webm only');
    return;
  }
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-i',
    webm,
    '-vf',
    'scale=1280:-2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '28',
    '-an',
    resolve(OUT, 'chat-knowledge.mp4'),
  ]);
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-i',
    webm,
    '-vf',
    'fps=8,scale=960:-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5',
    resolve(OUT, 'chat-knowledge.gif'),
  ]);
  rmSync(webm, { force: true });
  log('  🎞 chat-knowledge.gif / .mp4');
});

await browser.close();

// ─── WebP (keeps the repo light; PNGs are the intermediate) ──

await step('webp', async () => {
  if (spawnSync('cwebp', ['-version'], { stdio: 'ignore' }).status !== 0) {
    log('  ⚠ cwebp not found — keeping PNGs (brew install webp)');
    return;
  }
  for (const f of readdirSync(OUT).filter((f) => f.endsWith('.png'))) {
    const png = resolve(OUT, f);
    execFileSync('cwebp', ['-quiet', '-q', '82', png, '-o', png.replace(/\.png$/, '.webp')]);
    rmSync(png);
  }
  log('  🗜 png → webp');
});

// ─── Report ─────────────────────────────────────────────

log('\n=== capture report ===');
for (const r of report) log(`${r.ok ? '✓' : '✗'} ${r.name}${r.error ? ` — ${r.error}` : ''}`);
const issues = [...new Set(diag.issues)];
log(`\nconsole/API issues: ${issues.length}`);
for (const i of issues) log(`  • ${i}`);
const files = readdirSync(OUT).filter((f) => !f.startsWith('.'));
log(`\n${files.length} files in ${OUT}`);
process.exit(report.some((r) => !r.ok) || issues.length > 0 ? 1 : 0);
