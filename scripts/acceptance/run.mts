/** Real-provider acceptance. Use a disposable local dev-real.sh stack; never a production workspace. */
import { chromium, expect as baseExpect, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Base, Message, NeedsYou, RunDetail, RunView, MemberSummary } from '@greenhouse/contract';
import { PEOPLE } from '../../apps/web/e2e/env.js';

const expect = baseExpect.configure({ timeout: 15000 });
const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://127.0.0.1:4885' },
    out: { type: 'string', default: 'artifacts/v2-delivery' },
    only: { type: 'string' },
    wait: { type: 'string', default: '240000' },
  },
});
const origin = new URL(values.base!).origin;
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname))
  throw new Error('Acceptance writes test data: --base must be loopback.');
const out = resolve(values.out!);
const wait = Number(values.wait);
if (!Number.isFinite(wait) || wait < 10000) throw new Error('--wait must be milliseconds, at least 10000.');
await mkdir(join(out, 'screenshots'), { recursive: true });
const selected = values.only?.split(',');
if (selected?.some((id) => !/^F(?:0[1-9]|1[0-2])$/.test(id))) throw new Error('--only expects F01 through F12.');
const titles = [
  '登录与中文主线',
  '搜索、个人文档与撤销',
  '共享文档批准与续跑',
  '共享文档拒绝',
  '表格结构、批量回执与撤销',
  '电脑截图、观看与接管',
  '后台研究、通知与结果',
  '房间、提及与连续发送',
  '应用搭建、发布与阅读',
  '管理、服务与运行开关',
  '设置、通知与窄屏布局',
  'iOS 原生验收',
];
type Check = { title: string; status: 'pass' | 'fail' | 'partial'; expected: string; actual: string };
type Result = {
  id: string;
  title: string;
  status: 'pass' | 'fail' | 'partial';
  notes: string[];
  screenshots: string[];
  checks: Check[];
};
type State = {
  stamp: string;
  threads: Record<string, string>;
  base?: Base;
  doc?: string;
  run?: string;
  room?: string;
  app?: string;
  folder?: string;
};
let state: State;
try {
  if (!selected) throw new Error('Start a new acceptance run.');
  state = JSON.parse(await readFile(join(out, 'state.json'), 'utf8'));
} catch {
  state = { stamp: new Date().toISOString().replace(/\D/g, '').slice(0, 14), threads: {} };
}
state.stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
state.folder = undefined;
let results: Result[] = [];
if (selected) {
  try {
    results = JSON.parse(await readFile(join(out, 'results.json'), 'utf8'));
  } catch {
    /* First selected run. */
  }
}
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Taipei',
  colorScheme: 'light',
});
context.setDefaultTimeout(15000);
const page = await context.newPage();
const tokens = new Map<string, string>();
let current: Result;
const name = (suffix: string) => `T17-${state.stamp}-${suffix}`;
const composer = (p = page) => p.locator('.app-composer-input');
const safeError = (error: unknown) =>
  String(error)
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 2200);
async function persist() {
  await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2));
  await writeFile(join(out, 'state.json'), JSON.stringify(state, null, 2));
}
async function api<T = any>(path: string, method = 'GET', data?: unknown, who = 'lin'): Promise<T> {
  if (!tokens.has(who)) {
    const person = PEOPLE[who as keyof typeof PEOPLE];
    const r = await context.request.post(`${origin}/api/auth/login`, {
      data: { email: person.email, password: person.password, client: 'web' },
    });
    if (!r.ok()) throw new Error(`Test account sign-in: HTTP ${r.status()}`);
    tokens.set(who, (await r.json()).access_token);
  }
  const r = await context.request.fetch(`${origin}${path}`, {
    method,
    headers: { authorization: `Bearer ${tokens.get(who)}` },
    ...(data === undefined ? {} : { data }),
    timeout: 30000,
  });
  if (!r.ok()) throw new Error(`${method} ${path}: HTTP ${r.status()} ${await r.text()}`);
  return r.status() === 204 ? (undefined as T) : r.json();
}
async function open(path: string, p = page) {
  await p.goto(`${origin}/#${path}`);
  await expect(p.getByRole('main').getByRole('heading', { level: 1 }).first()).toBeVisible();
}
async function expandProcess() {
  await expect(page.locator('button.gh-chat-card-header').first()).toBeVisible();
  for (const button of await page.locator('button.gh-chat-card-header[aria-expanded="false"]').all())
    await button.click();
}
async function capture(label: string, p = page) {
  for (const [suffix, theme, width, height] of [
    ['light', 'light', 1440, 900],
    ['dark', 'dark', 1440, 900],
    ['narrow', 'light', 390, 844],
  ] as const) {
    await p.setViewportSize({ width, height });
    await p.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await p.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await p.waitForTimeout(350);
    const file = `screenshots/${current.id}-${label}-${suffix}.png`;
    await p.screenshot({ path: join(out, file) });
    current.screenshots.push(file);
    const overflow = await p.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
    if (overflow.content > overflow.width)
      current.checks.push({
        title: `${label} ${suffix} 横向布局`,
        status: 'fail',
        expected: '无页面横向溢出',
        actual: JSON.stringify(overflow),
      });
  }
  await p.setViewportSize({ width: 1440, height: 900 });
  await p.emulateMedia({ colorScheme: 'light' });
  await p.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
  await persist();
}
async function check(title: string, expected: string, fn: () => Promise<unknown>) {
  try {
    const actual = await fn();
    current.checks.push({ title, expected, status: 'pass', actual: typeof actual === 'string' ? actual : '已验证' });
  } catch (error) {
    current.checks.push({ title, expected, status: 'fail', actual: safeError(error) });
  }
}
function partial(title: string, reason: string) {
  current.checks.push({ title, expected: '完成检查', status: 'partial', actual: reason });
}
async function caseRun(id: string, fn: () => Promise<void>) {
  if (selected && !selected.includes(id)) return;
  current = { id, title: titles[Number(id.slice(1)) - 1]!, status: 'partial', notes: [], screenshots: [], checks: [] };
  results = results
    .filter((r) => r.id !== id)
    .concat(current)
    .sort((a, b) => a.id.localeCompare(b.id));
  process.stdout.write(`${id} ${current.title}\n`);
  try {
    await fn();
  } catch (error) {
    current.checks.push({ title: '执行中断', expected: '完成所有检查点', actual: safeError(error), status: 'fail' });
    await capture('failure').catch(() => undefined);
  }
  current.status = current.checks.some((c) => c.status === 'fail')
    ? 'fail'
    : current.checks.some((c) => c.status === 'partial') || !current.checks.length
      ? 'partial'
      : 'pass';
  current.notes.push(...current.checks.map((c) => `${c.status}: ${c.title} — ${c.actual}`));
  await persist();
  process.stdout.write(`${id}: ${current.status}\n`);
}
async function thread(id: string) {
  const c = await api<{ id: string }>('/api/conversations', 'POST', { kind: 'chat' });
  state.threads[id] = c.id;
  await persist();
  await open(`/c/${c.id}`);
  return c.id;
}
async function messages(id: string) {
  return (await api<{ items: Message[] }>(`/api/conversations/${id}/messages?limit=200`)).items;
}
async function requests(id: string) {
  return (await api<{ items: NeedsYou[] }>(`/api/requests?conversation_id=${id}`)).items;
}
async function send(text: string, id: string) {
  current.notes.push(`输入：${text}`);
  const before = (await messages(id)).filter((m) => m.role === 'assistant').map((m) => m.id);
  await composer().fill(text);
  await composer().press('Enter');
  await expect
    .poll(async () => (await messages(id)).some((m) => m.role === 'user' && m.content === text), { timeout: 30000 })
    .toBe(true);
  await expect
    .poll(
      async () => {
        const ms = await messages(id);
        return (
          (await requests(id)).length > 0 ||
          ms.some((m) => m.role === 'assistant' && !before.includes(m.id) && m.status !== 'streaming')
        );
      },
      { timeout: wait, intervals: [1000, 2000] },
    )
    .toBe(true);
  await page.waitForTimeout(1500);
  await writeFile(join(out, `${current.id}-messages.json`), JSON.stringify(await messages(id), null, 2));
}
async function settle(id: string) {
  await page.waitForTimeout(2000);
  await expect
    .poll(async () => !(await messages(id)).some((m) => m.status === 'streaming'), { timeout: wait, intervals: [2000] })
    .toBe(true);
  await page.waitForTimeout(1000);
}
async function approveAll(id: string) {
  for (let n = 0; n < 8; n++) {
    let pending = await requests(id);
    if (!pending.length) {
      await settle(id);
      pending = await requests(id);
      if (!pending.length) return;
    }
    for (const request of pending.filter((r) => r.kind === 'approval')) {
      const calls = (request.payload.calls ?? [request.payload]) as { tool?: string }[];
      if (
        request.payload.tier === 'tier3' ||
        calls.some((call) => !/^(knowledge_mutation|table_schema_plan|tables_)/.test(call.tool ?? ''))
      )
        throw new Error('Unexpected approval outside reversible knowledge/table writes; left pending.');
    }
    const button = page.getByRole('button', { name: '批准', exact: true }).first();
    if (!(await button.isVisible())) return;
    await button.click();
    await page.waitForTimeout(2500);
    await settle(id);
  }
}
async function otherPerson(who: 'mei' | 'kai'): Promise<{ context: BrowserContext; page: Page }> {
  const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const r = await context.request.post(`${origin}/api/auth/login`, {
    data: { email: PEOPLE[who].email, password: PEOPLE[who].password, client: 'web' },
  });
  if (!r.ok()) {
    await c.close();
    throw new Error(`Test account sign-in: HTTP ${r.status()}`);
  }
  const session = await r.json();
  await c.addInitScript(
    ({ origin, session }) => {
      if (location.origin === origin) localStorage.setItem('greenhouse.session', JSON.stringify(session));
    },
    { origin, session },
  );
  return { context: c, page: await c.newPage() };
}

try {
  await page.goto(origin);
  await page.getByLabel(/邮箱|Email/).fill(PEOPLE.lin.email);
  await page.getByLabel(/密码|Password/).fill(PEOPLE.lin.password);
  await page.getByRole('button', { name: /登录|Sign in/ }).click();
  await expect(composer()).toBeVisible();
  await writeFile(
    join(out, 'environment.json'),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        base: origin,
        turn_wait_ms: wait,
        viewport: ['1440×900 light', '1440×900 dark', '390×844 light'],
        provider: await api('/api/admin/providers'),
      },
      null,
      2,
    ),
  );

  await caseRun('F01', async () => {
    await open('/c/main');
    await check('中文欢迎与主线', '主线出现中文欢迎，Greeny 可输入消息', async () => {
      await expect(page.locator('.app-message').first()).toContainText(/你好.*Greeny/);
      await expect(composer()).toBeVisible();
      await expect(page.getByRole('main')).toContainText('Greeny');
    });
    await capture('main');
  });
  await caseRun('F02', async () => {
    const id = await thread('F02');
    const title = name('个人研究');
    await send(
      `请用中文搜索网页，核实截至今天 PostgreSQL 最新稳定版本及主要变化，引用网页来源。然后在你自己的个人知识库文件夹写一篇名为「${title}」的文档，使用 Markdown 标题和加粗，并给我可打开的文档链接。请真正搜索并写入，不要只给草稿。`,
      id,
    );
    if ((await requests(id)).length) {
      partial('个人写入无需确认', '搜索后的写入出现审批卡；继续批准以检查文档和回执。');
      await capture('approval');
      await approveAll(id);
    }
    await check('网页出处', '回答有可访问的网页出处', async () => {
      const ms = await messages(id);
      expect(
        ms.some(
          (m) => m.role === 'assistant' && (m.citations.some((c) => c.kind === 'web') || /https?:\/\//.test(m.content)),
        ),
      ).toBe(true);
    });
    const receipts = (await messages(id)).filter((m) => m.event?.type === 'write_receipt');
    await check('具名写入回执', '回执包含文档名和撤销操作', async () => {
      expect(receipts.some((m) => m.content.includes(title))).toBe(true);
      await expect(page.getByRole('button', { name: '撤销这次写入' }).first()).toBeVisible();
    });
    await capture('receipt');
    const docLink = page.getByRole('main').locator('a[href*="#/knowledge/doc_"]').last();
    await expect(docLink).toBeVisible();
    const href = await docLink.getAttribute('href');
    state.doc = href!.match(/doc_[A-Z0-9]+/)![0];
    await docLink.click();
    await check('文档页面', '文档标题与 Markdown 正常渲染', async () => {
      await expect(page.locator('.app-page-header').getByRole('heading', { level: 1, name: title })).toBeVisible();
      await expect(page.locator('.app-doc-content')).toBeVisible();
    });
    await capture('doc');
    await open(`/c/${id}`);
    await page.getByRole('button', { name: '撤销这次写入' }).last().click();
    await check('撤销删除文档', '文档已移入归档，不再显示在活动目录', async () => {
      await expect(page.getByRole('button', { name: '已撤销' }).last()).toBeDisabled();
      const r = await context.request.get(`${origin}/api/knowledge/docs/${state.doc}`, {
        headers: { authorization: `Bearer ${tokens.get('lin')}` },
      });
      if (r.ok()) expect((await r.json()).archived_at).toBeTruthy();
      else expect([403, 404, 410]).toContain(r.status());
    });
    await capture('undo');
  });
  for (const [fid, reject] of [
    ['F03', false],
    ['F04', true],
  ] as const)
    await caseRun(fid, async () => {
      const id = await thread(fid);
      const title = name(reject ? '拒绝文档' : '共享文档');
      if (!state.folder)
        state.folder = (await api('/api/knowledge/folders', 'POST', { name: name('共享知识'), space: 'team' })).id;
      await send(
        `请在团队知识库的「${name('共享知识')}」文件夹（${state.folder}）真正新建文档「${title}」，正文是 Markdown：一级标题「验收说明」，加粗「审批」，并写两点合作规则。共享写入请发审批卡，等我决定再执行，批准后给文档链接。`,
        id,
      );
      await check('位置、Markdown 与等待步骤', '显示文件夹名、格式化标题和粗体，步骤等你批准', async () => {
        await expect(page.locator('.app-request-details')).toContainText(name('共享知识'));
        await expect(page.locator('.app-markdown-preview h1')).toContainText('验收说明');
        await expect(
          page
            .locator('.app-markdown-preview strong')
            .filter({ hasText: /^审批$/ })
            .first(),
        ).toBeVisible();
        await expect(page.locator('.app-markdown-preview')).not.toContainText('**');
        await expandProcess();
        await expect(
          page
            .locator('.app-step-summary')
            .filter({ hasText: /等你批准/ })
            .first(),
        ).toBeVisible();
        await expect(page.locator('.app-title-status')).toHaveText('等你确认', { timeout: 30000 });
      });
      await capture('waiting');
      const pending = await requests(id);
      expect(pending.length).toBeGreaterThan(0);
      if (reject) {
        await page.getByRole('button', { name: '拒绝', exact: true }).first().click();
        await settle(id);
        await check('拒绝后的步骤与文档', '步骤未执行，文件夹内没有文档', async () => {
          await expandProcess();
          await expect(
            page
              .locator('.app-step-summary')
              .filter({ hasText: /未执行：.*已拒绝/ })
              .first(),
          ).toBeVisible();
          const children = await api(`/api/knowledge/folders/${state.folder}`);
          expect(children.children.some((d: any) => d.title === title || d.name === title)).toBe(false);
        });
      } else {
        await approveAll(id);
        await check('批准后续跑与链接', '审批完成后 Agent 继续并链接新文档', async () => {
          await expect(page.getByRole('main').locator('a[href*="#/knowledge/doc_"]').last()).toBeVisible({
            timeout: wait,
          });
          const href = await page.getByRole('main').locator('a[href*="#/knowledge/doc_"]').last().getAttribute('href');
          state.doc = href!.match(/doc_[A-Z0-9]+/)![0];
          expect((await api(`/api/knowledge/docs/${state.doc}`)).title).toBe(title);
        });
      }
      await capture(reject ? 'rejected' : 'approved');
    });
  await caseRun('F05', async () => {
    const id = await thread('F05');
    await send(
      `请真正创建表格「${name('客户')}」，一张同名数据表，恰好四个字段：客户名（文本主字段）、金额（数字）、阶段（单选：新客户、洽谈中、已成交）、签约日（日期）。先提交可确认的结构计划，批准后新增三条记录：青禾/100/新客户/2026-10-15，云杉/200/洽谈中/2026-10-16，海棠/300/已成交/2026-10-17。三条在同一个回合连续创建，给批量回执和链接，不要重复主字段。`,
      id,
    );
    await check('可读结构计划', '字段类型和选项芯片可读，无内部类型', async () => {
      const d = page.locator('.app-request-details');
      await expect(d).toContainText('客户名');
      await expect(d).toContainText('金额');
      await expect(d.locator('.app-detail-chips')).toContainText('新客户');
      await expect(d).not.toContainText('single_select');
    });
    await capture('plan');
    await approveAll(id);
    const bases = (await api<{ items: Base[] }>('/api/tables/bases')).items;
    const b = bases.find((b) => b.name === name('客户'));
    expect(b).toBeTruthy();
    state.base = await api<Base>(`/api/tables/bases/${b!.id}`);
    await check('四字段与三记录', '恰好四字段，主字段只出现一次，三条记录', async () => {
      const table = state.base!.tables[0]!;
      expect(table.fields).toHaveLength(4);
      expect(table.fields.filter((f) => f.name === '客户名')).toHaveLength(1);
      expect(table.fields.map((f) => f.type).sort()).toEqual(['date', 'number', 'single_select', 'text']);
      expect((await api(`/api/tables/tables/${table.id}/records/query`, 'POST', {})).items).toHaveLength(3);
    });
    const receipts = (await messages(id)).filter(
      (m) => m.event?.type === 'write_receipt' && /青禾|云杉|海棠/.test(m.content),
    );
    await check('批量回执', '同一卡片列出三条新增记录且用词正确', async () => {
      expect(receipts).toHaveLength(1);
      for (const label of ['青禾', '云杉', '海棠']) expect(receipts[0]!.content).toContain(label);
      expect(receipts[0]!.content).toContain('新增记录');
    });
    await capture('records');
    const card = page.locator('.gh-chat-card').filter({ hasText: '青禾' }).last();
    await card.getByRole('button', { name: '撤销这次写入' }).click();
    await check('批量撤销', '一次撤销清除三条记录', async () => {
      await expect(card.getByRole('button', { name: '已撤销' })).toBeDisabled();
      expect(
        (await api(`/api/tables/tables/${state.base!.tables[0]!.id}/records/query`, 'POST', {})).items,
      ).toHaveLength(0);
    });
    await capture('undo');
    await open('/tables');
    await check('表格目录无重复名称', '同一目录行只显示一次名称', async () => {
      const row = page.locator('.app-list-row').filter({ hasText: name('客户') });
      await expect(row).toHaveCount(1);
      expect((await row.innerText()).split(name('客户')).length - 1).toBe(1);
    });
    await capture('directory');
  });
  await caseRun('F06', async () => {
    const id = await thread('F06');
    await send(
      '请在你的电脑浏览器打开 https://example.com ，实际拍一张当前屏幕截图发给我。不要只描述页面，回复必须附带真实截图图片，即使当前模型只能读文字。',
      id,
    );
    await check('回复含截图', '截图加载为图片', async () => {
      await expect(page.locator('.app-message img').last()).toBeVisible({ timeout: 30000 });
      expect(
        await page
          .locator('.app-message img')
          .last()
          .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
      ).toBe(true);
    });
    await check('截图回复无内部文件编号', '模型正文不包含内部文件编号', async () => {
      const ms = await messages(id);
      expect(ms.filter((m) => m.role === 'assistant').some((m) => /fil_[0-9A-Z]{20,}/.test(m.content))).toBe(false);
    });
    await capture('reply');
    await page.getByRole('main').getByRole('button', { name: '电脑', exact: true }).click();
    await check('电脑实时画面', '抽屉出现实时屏幕', async () => {
      await expect(page.getByText('正在观看', { exact: true })).toBeVisible({ timeout: 60000 });
      await expect(page.locator('.app-screen-canvas canvas')).toBeVisible();
    });
    await capture('computer');
    await page.getByRole('button', { name: '接管', exact: true }).click();
    await check('接管', '显示成员正在操作', async () => {
      await expect(page.getByText('你在操作这台电脑')).toBeVisible();
    });
    await capture('control');
    await page.getByRole('button', { name: '回到观看', exact: true }).click();
    await check('交还', '恢复观看', async () => {
      await expect(page.getByText('正在观看', { exact: true })).toBeVisible();
    });
    await capture('returned');
    await page.keyboard.press('Escape');
  });
  await caseRun('F07', async () => {
    const id = await thread('F07');
    await send(
      `请提议一个后台运行「${name('后台研究')}」，不要在前台直接做：研究 PostgreSQL 18，先搜索并读取 https://www.postgresql.org/docs/18/release-18.html ，再把阶段笔记写入你的个人知识库，随后读回自己的阶段笔记，再次读取一个官网网页核对，最后创建 Markdown 报告并在完成汇报链接报告。声明使用搜索和网页阅读，不使用电脑。请先让我确认启动。`,
      id,
    );
    await check('提议的网络权限与等待头部', '卡片明确允许搜索和网页阅读，头部等你确认', async () => {
      const req = (await requests(id)).find((r) => r.subject === 'run_start');
      expect(req).toBeTruthy();
      expect(String(req!.payload.access_summary)).toMatch(/搜索|网页/);
      await expect(page.locator('.app-title-status')).toHaveText('等你确认', { timeout: 30000 });
      await expect(page.getByRole('button', { name: '开始运行', exact: true })).toBeVisible();
    });
    await capture('proposal');
    await page.getByRole('button', { name: '开始运行', exact: true }).click();
    await expect
      .poll(
        async () => {
          const runs = (await api<{ items: RunView[] }>('/api/runs')).items;
          const run = runs.find((r) => r.title === name('后台研究') || r.conversation_id === id);
          state.run = run?.id;
          return !!run;
        },
        { timeout: 30000 },
      )
      .toBe(true);
    let detail: RunDetail;
    await expect
      .poll(
        async () => {
          detail = await api<RunDetail>(`/api/runs/${state.run}`);
          // Approve only this requested research's reversible document writes.
          if (detail.status === 'waiting') {
            const pending = (await requests(id)).filter((r) => r.kind === 'approval');
            if (pending.length) {
              await open(`/c/${id}`);
              await approveAll(id);
            }
          }
          return ['succeeded', 'failed', 'canceled'].includes(detail.status);
        },
        { timeout: Math.max(wait * 3, 600000), intervals: [3000] },
      )
      .toBe(true);
    detail = await api<RunDetail>(`/api/runs/${state.run}`);
    await writeFile(join(out, 'F07-run.json'), JSON.stringify(detail, null, 2));
    await check('后台完成与写后再读网页', '成功完成，读回自身输出后仍执行 web_fetch', async () => {
      expect(detail.status).toBe('succeeded');
      const read = detail.steps.findIndex(
        (s) =>
          s.tool === 'tool_output_read' ||
          (s.tool === 'knowledge_query' && (s.input as { action?: string })?.action === 'read'),
      );
      expect(read).toBeGreaterThanOrEqual(0);
      expect(detail.steps.slice(read + 1).some((s) => /web_fetch/.test(s.tool ?? '') && s.status === 'succeeded')).toBe(
        true,
      );
      expect(detail.output).toMatch(/#\/knowledge\/doc_/);
    });
    await open('/notifications?view=all');
    await check('完成通知', '通知链接该运行或报告', async () => {
      await expect(page.getByRole('main')).toContainText(name('后台研究'), { timeout: 30000 });
    });
    await capture('notification');
    await open(`/runs/${state.run}`);
    await capture('report');
    await open('/runs');
    await check('无活动运行时展示完成结果', '已结束运行预览和打开入口', async () => {
      await expect(page.getByRole('link', { name: '查看已结束的运行' })).toBeVisible();
      await expect(page.getByRole('main')).toContainText(name('后台研究'));
    });
    await capture('finished');
  });
  await caseRun('F08', async () => {
    const people = (await api<{ items: MemberSummary[] }>('/api/members')).items;
    const mei = people.find((p) => p.name === 'Mei')!;
    const room = await api('/api/conversations', 'POST', {
      kind: 'room',
      title: name('一起讨论'),
      member_ids: [mei.id],
      agent_ids: ['main'],
    });
    state.room = room.id;
    await open(`/c/${room.id}`);
    await check('空房间成员与提示', '显示成员和 @ 提示', async () => {
      await expect(page.getByText('@ 一个 Agent 让它回答', { exact: true })).toBeVisible();
      await expect(page.locator('.app-room-roster')).toContainText('Mei');
      await expect(page.locator('.app-room-roster')).toContainText('Greeny');
    });
    await capture('empty');
    const other = await otherPerson('mei');
    try {
      await composer().fill('@Me');
      await composer().press('Enter');
      if ((await composer().inputValue()) === '@Me') {
        await expect(page.getByRole('option', { name: /Mei/ })).toBeVisible();
        await composer().press('Enter');
      }
      await check('快速 Enter 选中真实提及', '选中 Mei，未意外发送', async () => {
        await expect(composer()).toHaveValue('@Mei ');
      });
      await composer().pressSequentially(' 请查看验收记录');
      await composer().press('Enter');
      await composer().fill('第二条连续消息');
      await composer().press('Enter');
      await check('连续两条消息到达', '两条消息保留且提及结构化', async () => {
        await expect.poll(async () => (await messages(room.id)).filter((m) => m.role === 'user').length).toBe(2);
        const ms = (await messages(room.id)).filter((m) => m.role === 'user');
        expect(JSON.stringify(ms)).toContain(mei.id);
        expect(ms.some((m) => m.content === '第二条连续消息')).toBe(true);
      });
      await open('/notifications?view=all', other.page);
      await check('Mei 的提及通知', 'Mei 得到房间提及通知', async () => {
        await expect(
          other.page.getByRole('link', { name: new RegExp(`Lin 在「${name('一起讨论')}」里提到了你`) }),
        ).toBeVisible();
      });
      await capture('mention', other.page);
      await composer().fill('@');
      await page.getByRole('option', { name: /Greeny/ }).click();
      await composer().pressSequentially(' 请用中文简短确认已看到房间讨论');
      await composer().press('Enter');
      await expect
        .poll(async () => (await messages(room.id)).some((m) => m.role === 'assistant' && m.status !== 'streaming'), {
          timeout: wait,
        })
        .toBe(true);
      await open(`/c/${room.id}`, other.page);
      await check('Agent 回复归属', 'Mei 看到 Greeny · Lin', async () => {
        await expect(other.page.locator('.app-message').filter({ hasText: 'Greeny · Lin' }).first()).toBeVisible();
      });
      await capture('reply', other.page);
    } finally {
      await other.context.close();
    }
  });
  await caseRun('F09', async () => {
    if (!state.base) {
      partial('使用真实模型创建的表格', 'F05 未创建可用表格，无法验收应用。');
      return;
    }
    // F05 deliberately undoes its records. Add a human record to make the runtime readable.
    const table = state.base.tables[0]!;
    await api(`/api/tables/tables/${table.id}/records`, 'POST', {
      values: Object.fromEntries(
        table.fields.map((field) => [
          field.id,
          field.type === 'number'
            ? 1000
            : field.type === 'date'
              ? '2026-10-15'
              : field.type === 'single_select'
                ? (field.config.options as { id: string }[])[0]!.id
                : '应用验收客户',
        ]),
      ),
    });
    await open('/apps');
    await page.getByRole('main').getByRole('button', { name: '新建应用', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建应用', exact: true });
    await dialog.getByRole('textbox', { name: '应用名称' }).fill(name('客户应用'));
    await dialog.getByRole('combobox', { name: '使用的表格' }).click();
    await page.getByRole('option', { name: state.base.name, exact: true }).click();
    await dialog.getByRole('button', { name: '新建应用', exact: true }).click();
    await expect(page).toHaveURL(/#\/apps\/app_.*\/edit/);
    state.app = page.url().match(/app_[A-Z0-9]+/)![0];
    await page.locator('.app-ap-canvas').getByRole('button', { name: '添加卡片', exact: true }).click();
    const add = page.getByRole('dialog', { name: '添加卡片', exact: true });
    await add.getByRole('combobox', { name: '卡片类型' }).click();
    await page.getByRole('option', { name: '记录列表', exact: true }).click();
    await add.getByRole('button', { name: '添加卡片', exact: true }).click();
    const edit = page.getByRole('dialog', { name: '编辑卡片', exact: true });
    await edit.getByRole('textbox', { name: '卡片标题' }).fill('客户列表');
    await edit.getByRole('button', { name: '保存', exact: true }).click();
    await capture('builder');
    await page.getByRole('button', { name: '发布应用', exact: true }).click();
    await capture('publish');
    await page.getByRole('dialog', { name: '确认发布' }).getByRole('button', { name: '发布应用', exact: true }).click();
    await check('已发布与打开入口', '搭建器显示已发布版本和打开应用', async () => {
      await expect(page.locator('.app-page-header')).toContainText('已发布 · v1');
      await expect(page.getByRole('button', { name: '打开应用', exact: true })).toBeVisible();
    });
    await capture('published');
    await page.getByRole('button', { name: '打开应用', exact: true }).click();
    await check('应用记录可读', '运行时显示客户名而非内部数据', async () => {
      await expect(page.locator('.app-ap-record')).toContainText('应用验收客户');
    });
    await capture('runtime');
  });
  await caseRun('F10', async () => {
    for (const section of ['members', 'services', 'usage', 'public-agents', 'operations']) {
      await open(`/admin/${section}`);
      await check(`${section} 可读`, '内容加载，没有原始 JSON 或内部对象 ID', async () => {
        await expect(page.getByRole('main')).not.toContainText(/(?:mbr|agt|prv|run)_[0-9A-Z]{20,}/);
        expect(await page.getByRole('main').locator('pre').count()).toBe(0);
      });
      if (section === 'services') {
        await page
          .getByRole('button', { name: /大模型/ })
          .first()
          .click();
        await capture('service-detail');
        await page.keyboard.press('Escape');
      }
      await capture(section);
    }
    await open('/admin/usage');
    await page.getByRole('button', { name: '添加预算', exact: true }).click();
    await check('预算编辑器', '月度上限可编辑，标签可读', async () => {
      await page.getByRole('dialog', { name: '添加预算' }).getByLabel('每月上限').fill('5000000');
    });
    await capture('budget-dialog');
    await page.keyboard.press('Escape');
    await open('/admin/operations');
    const member = await otherPerson('mei');
    try {
      await page.getByRole('switch', { name: '禁用电脑', exact: true }).click();
      await expect.poll(async () => (await api('/api/admin/operations')).disable_computers).toBe(true);
      await open('/agents/main?tab=computer', member.page);
      await member.page.getByRole('button', { name: '开机', exact: true }).click();
      await check('禁用电脑的成员提示', '成员明确看到电脑被管理员禁用', async () => {
        await expect(member.page.getByText(/管理员.*(?:暂停|禁用)|电脑.*暂停/)).toBeVisible();
        await expect(member.page.getByRole('main')).not.toContainText('An admin temporarily paused');
      });
      await capture('computer-disabled', member.page);
    } finally {
      await member.context.close();
      await open('/admin/operations');
      const toggle = page.getByRole('switch', { name: '禁用电脑', exact: true });
      if (await toggle.isChecked()) await toggle.click();
      await expect(toggle).not.toBeChecked();
      await expect.poll(async () => (await api('/api/admin/operations')).disable_computers).toBe(false);
      await capture('computers-enabled');
    }
    const manifest = await api('/api/extensions');
    await writeFile(join(out, 'F10-extensions.json'), JSON.stringify(manifest, null, 2));
    partial('扩展页面', 'dev-real.sh 未启用示例扩展；记录实际扩展清单，不将空清单算成功页面验收。');
  });
  await caseRun('F11', async () => {
    for (const [label, path] of [
      ['account', '/settings/account'],
      ['preferences', '/settings/notifications'],
      ['notifications', '/notifications?view=all'],
      ['main', '/c/main'],
      ['knowledge', '/knowledge'],
      ['tables', '/tables'],
      ['apps', '/apps'],
      ['agents', '/agents'],
      ['runs', '/runs'],
      ['skills', '/skills'],
    ]) {
      await open(path!);
      await check(`${label} 页面可见`, '页面标题正常加载', async () => {
        await expect(page.getByRole('main').getByRole('heading', { level: 1 }).first()).toBeVisible();
      });
      await capture(label!);
    }
  });
  await caseRun('F12', async () => {
    partial(
      '原生人工检查',
      'Playwright 只验收 Web。iOS 必须在指定 Greenhouse v2 Mobile QA 模拟器通过原生工具补充截图和记录，不能以窄屏 Web 代替。',
    );
  });
} finally {
  await context.close();
  await browser.close();
  await persist();
}
process.stdout.write(`Evidence: ${out}/results.json\n`);
process.exitCode = results.some((r) => r.status === 'fail') ? 1 : 0;
