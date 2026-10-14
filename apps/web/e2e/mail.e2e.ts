import { createHmac, randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { apiAs } from './api';
import { E2E } from './env';
import { as, composer, open } from './fixtures';

/**
 * 邮箱 (PRV-16, NTF-04, AGNT-30, OPEN-05): an admin sets up mail with Resend (fake-mail.mjs), system
 * mail goes out, mail to an Agent's address lands in its thread and wakes it, a held-back sender is
 * let in, the Agent's reply waits for approval, and a member's own mailbox becomes a connector.
 * The tests sign Resend's `email.received` notices themselves.
 */

test.describe.configure({ mode: 'serial' });

const FAKE = `http://127.0.0.1:${E2E.llmPort}`;
/** fake-mail.mjs: the key its Resend takes, and the member's own mailbox. */
const RESEND_KEY = 're_e2e_0123456789';
const MAILBOX_PASSWORD = 'mailbox-password';
const WEBHOOK_SECRET = `whsec_${Buffer.from('greenhouse-e2e-webhook-secret').toString('base64')}`;
const DOMAIN = 'agents.acme.test';

/** Set by the first tests: where Resend posts its notices, and Lin's main Agent's address. */
let inboundUrl = '';
let address = '';

interface Sent {
  from: string;
  to: string[];
  subject: string;
  text: string;
  headers?: Record<string, string>;
}

const sent = async (request: APIRequestContext) => (await (await request.get(`${FAKE}/resend/_sent`)).json()) as Sent[];
const sentTo = async (request: APIRequestContext, who: string) =>
  (await sent(request)).filter((mail) => mail.to.some((entry) => entry.includes(who)));

/** Resend "receives" this mail; its signed notice goes to the inbound address the admin page shows. */
async function receive(request: APIRequestContext, mail: Record<string, unknown>) {
  const { id } = (await (await request.post(`${FAKE}/resend/_inbound`, { data: mail })).json()) as { id: string };
  const body = JSON.stringify({ type: 'email.received', created_at: new Date().toISOString(), data: { email_id: id } });
  const notice = `msg_${randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', Buffer.from(WEBHOOK_SECRET.slice('whsec_'.length), 'base64'))
    .update(`${notice}.${timestamp}.${body}`)
    .digest('base64');
  const response = await request.post(inboundUrl, {
    headers: {
      'content-type': 'application/json',
      'svix-id': notice,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${signature}`,
    },
    data: body,
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as { status: string; delivered: number; screened: number };
}

test.afterAll(async ({ request }) => {
  // Mail off again, so later tests neither send mail nor show mailboxes.
  const providers = await apiAs<{
    capabilities: { capability: string; instances: { id: string; source: string }[] }[];
  }>(request, 'lin', 'GET', '/api/admin/providers');
  for (const instance of providers.capabilities.find((state) => state.capability === 'mail')?.instances ?? []) {
    if (instance.source !== 'env') await apiAs(request, 'lin', 'DELETE', `/api/admin/providers/${instance.id}`);
  }
});

test('admin: mail through Resend, a test mail, the Agent mail domain; email joins the notification channels', async ({
  page,
  request,
}) => {
  await open(page, '/#/admin/services');
  // Email is a service now, not a channel; Feishu and WeCom wait for the IM channels.
  await expect(page.getByRole('heading', { name: '通知渠道' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^邮件/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^飞书/ })).toHaveCount(0);

  await page.getByRole('button', { name: /^邮箱/ }).click();
  const drawer = page.getByRole('dialog', { name: '邮箱', exact: true });
  await expect(drawer.getByText('还没有能发信的服务')).toBeVisible();
  await drawer.getByRole('button', { name: '添加实例' }).click();
  const form = page.getByRole('dialog', { name: '添加邮箱' });
  await form.getByRole('combobox', { name: '服务商' }).click();
  await page.getByRole('option', { name: 'Resend' }).click();
  await form.getByLabel(/^名称/).fill('Resend');
  await form.getByLabel(/^地址/).fill(`${FAKE}/resend`);
  await form.getByLabel(/^发件地址/).fill('greenhouse@acme.test');
  await form.getByLabel(/^apiKey/).fill(RESEND_KEY);
  await form.getByLabel(/^webhookSecret/).fill(WEBHOOK_SECRET);
  await form.getByRole('button', { name: '添加', exact: true }).click();
  await expect(form).toBeHidden();

  // It can send: a test mail goes to me.
  await drawer.getByRole('button', { name: '发测试邮件给我' }).click();
  await expect(page.getByText('测试邮件已经通过 Resend 发出')).toBeVisible();
  expect(await sentTo(request, 'lin@example.com')).toHaveLength(1);

  // Agent mailboxes: the domain, and the address Resend posts received mail to.
  await expect(drawer).toContainText('Agent 邮箱未开通');
  await drawer.getByLabel(/^域名/).fill(DOMAIN);
  await drawer.getByRole('button', { name: '保存', exact: true }).click();
  await expect(drawer).toContainText('Agent 邮箱已开通');
  inboundUrl = await drawer.getByRole('textbox', { name: 'Resend 的入站地址' }).inputValue();
  expect(inboundUrl).toMatch(/\/api\/mail\/inbound\/\w+$/);
  await drawer.getByRole('button', { name: '关闭' }).click();

  // Now email is a channel a member can pick.
  await page.goto('/#/settings/notifications');
  const cell = page.getByRole('checkbox', { name: '需要你：邮件' });
  await expect(cell).not.toBeChecked();
  await cell.click();
  await expect(cell).toBeChecked();
  await expect(page.getByRole('switch', { name: '显示内容摘要' })).toHaveAttribute('aria-checked', 'false');
  await page.reload();
  await expect(page.getByRole('checkbox', { name: '需要你：邮件' })).toBeChecked();
  await page.getByRole('checkbox', { name: '需要你：邮件' }).click();
  await expect(page.getByRole('checkbox', { name: '需要你：邮件' })).not.toBeChecked();
});

test('admin: an invite goes out by mail, and its link is still there to hand over', async ({ page, request }) => {
  await open(page, '/#/admin/members');
  await page.getByRole('button', { name: '邀请成员' }).click();
  const dialog = page.getByRole('dialog', { name: '邀请成员' });
  await dialog.getByLabel('邮箱').fill('yan@example.com');
  await dialog.getByLabel('名字').fill('Yan');
  await dialog.getByRole('button', { name: '生成邀请链接' }).click();
  const done = page.getByRole('dialog', { name: '邮件已发出' });
  await expect(done).toContainText('yan@example.com 会收到一封带链接的邮件');
  const link = await done.getByRole('textbox', { name: '链接' }).inputValue();
  expect(link).toContain('#/activate?token=');
  await done.getByRole('button', { name: '完成' }).click();

  const [invite] = await sentTo(request, 'yan@example.com');
  expect(invite?.from).toContain('greenhouse@acme.test');
  expect(invite?.text).toContain(link);
});

test("mail to an Agent's address lands in its thread and wakes it; the mail opens cleaned", async ({
  page,
  request,
}) => {
  await open(page, '/#/agents/main?tab=mailbox');
  address = await page.getByRole('textbox', { name: '地址', exact: true }).inputValue();
  expect(address).toMatch(/^greeny-[a-z0-9]+@agents\.acme\.test$/);

  const result = await receive(request, {
    from: 'Lin <lin@example.com>',
    to: [address],
    subject: 'Quarterly numbers',
    text: 'Numbers for Q3 attached.',
    html: [
      '<p>Numbers for <b>Q3</b> attached.</p>',
      `<p><img src="${FAKE}/resend/pixel.gif" alt="pixel"></p>`,
      '<p><a href="https://acme.example/report">Report</a> <a href="javascript:alert(1)">Run me</a></p>',
      '<script>window.mailScriptRan = true</script>',
      '<p onclick="window.mailScriptRan = true" style="color: red">Thanks</p>',
    ].join(''),
    attachments: [{ filename: 'numbers.csv', content_type: 'text/csv', content: 'quarter,revenue\nQ3,42\n' }],
  });
  expect(result).toMatchObject({ status: 'ok', delivered: 1, screened: 0 });

  await open(page, '/');
  const card = page.locator('.app-mail-event').filter({ hasText: 'Quarterly numbers' });
  await expect(card).toContainText('来自 Lin');
  await expect(card).toContainText('1 个附件');
  // The fake model, woken by the mail, reads it with the mail tool.
  await expect(page.getByText('Read the mail: Quarterly numbers')).toBeVisible();

  await card.getByRole('button', { name: '打开邮件' }).click();
  const mail = page.getByRole('dialog', { name: 'Quarterly numbers' });
  await expect(mail).toContainText('发件人已验证');
  const body = mail.locator('.app-mail-html');
  await expect(body).toContainText('Numbers for Q3 attached.');
  await expect(body.locator('script, [onclick], [style]')).toHaveCount(0);
  await expect(body.getByRole('link', { name: 'Report' })).toHaveAttribute('target', '_blank');
  await expect(body.getByRole('link', { name: 'Run me' })).toHaveCount(0);
  // Remote images wait until asked.
  expect(await body.locator('img').getAttribute('src')).toBeNull();
  await mail.getByRole('button', { name: '显示远程图片' }).click();
  await expect(body.locator('img')).toHaveAttribute('src', `${FAKE}/resend/pixel.gif`);
  await expect(mail.getByRole('link', { name: 'numbers.csv' })).toHaveAttribute('href', /\/api\/files\//);
  expect(await page.evaluate(() => (window as { mailScriptRan?: boolean }).mailScriptRan)).toBeUndefined();
  await mail.getByRole('button', { name: '关闭' }).click();
});

test('a sender not on the list waits until the owner lets them in; a forged sender never wakes the Agent', async ({
  page,
  request,
}) => {
  expect(
    await receive(request, {
      from: 'Stranger <stranger@outside.example>',
      to: [address],
      subject: 'Partnership idea',
      text: 'Shall we work together?',
    }),
  ).toMatchObject({ delivered: 0, screened: 1 });
  // Lin's own address, but the sending server failed SPF, DKIM and DMARC.
  expect(
    await receive(request, {
      from: 'Lin <lin@example.com>',
      to: [address],
      subject: 'Urgent: wire the money',
      text: 'Send it now.',
      authentication: { spf: 'fail', dkim: 'fail', dmarc: 'fail' },
    }),
  ).toMatchObject({ delivered: 0, screened: 1 });

  await open(page, '/#/agents/main?tab=mailbox');
  const held = page.getByRole('region', { name: '待放行的邮件' });
  await expect(held.getByRole('listitem').filter({ hasText: 'Urgent: wire the money' })).toContainText(
    '发件人没有通过验证',
  );
  const row = held.getByRole('listitem').filter({ hasText: 'Partnership idea' });
  await expect(row).toContainText('发件人不在名单里');
  await row.getByRole('button', { name: '放行' }).click();
  await expect(page.getByText('已放行 stranger@outside.example，1 封邮件送进了对话')).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(page.getByRole('region', { name: '谁的来信能叫醒它' })).toContainText('stranger@outside.example');

  await open(page, '/');
  await expect(page.locator('.app-mail-event').filter({ hasText: 'Partnership idea' })).toContainText('来自 Stranger');
  await expect(page.getByText('Read the mail: Partnership idea')).toBeVisible();
  await expect(page.locator('.app-mail-event').filter({ hasText: 'Urgent: wire the money' })).toHaveCount(0);
});

test("the Agent's reply waits for approval, then goes out from its address in the same thread", async ({
  page,
  request,
}) => {
  await open(page, '/');
  await composer(page).fill('reply to the mail, please');
  await composer(page).press('Enter');
  const approval = page.locator('.gh-chat-card', { hasText: '回信给 stranger@outside.example' });
  await expect(approval).toContainText('需要你');
  // What goes out, from where, to whom.
  await expect(approval.locator('dt')).toHaveText(['发件人', '收件人', '主题', '正文']);
  await expect(approval.locator('dd')).toHaveText([
    address,
    'stranger@outside.example',
    'Re: Partnership idea',
    'Thanks, we got it.',
  ]);
  expect(await sentTo(request, 'stranger@outside.example')).toHaveLength(0);

  await approval.getByRole('button', { name: '批准' }).click();
  const out = page.locator('.app-mail-event').filter({ hasText: 'Re: Partnership idea' });
  await expect(out).toContainText('发给 stranger@outside.example');
  await expect(out).toContainText('已发出');
  const [reply] = await sentTo(request, 'stranger@outside.example');
  expect(reply?.from).toContain(address);
  expect(reply?.text).toBe('Thanks, we got it.');
  expect(reply?.headers?.['In-Reply-To']).toMatch(/@sender\.example>$/);
  expect(reply?.headers?.References).toContain(reply?.headers?.['In-Reply-To']);
});

test('a member connects their own mailbox, and their Agent searches it through the connector', async ({
  browser,
  request,
}) => {
  const ports = (await (await request.get(`${FAKE}/mailbox/_ports`)).json()) as { imap: number; smtp: number };
  const context = await browser.newContext({ storageState: as('mei'), locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const page = await context.newPage();
  await open(page, '/#/settings/connections');
  const row = page.getByRole('listitem').filter({ has: page.getByText('邮箱', { exact: true }) });
  await expect(row).toContainText('未连接');
  await row.getByRole('button', { name: '连接', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: '连接你的邮箱' });
  await dialog.getByLabel(/^邮箱地址/).fill('mei@example.com');
  for (const [legend, port] of [
    ['IMAP（收信）', ports.imap],
    ['SMTP（发信）', ports.smtp],
  ] as const) {
    const group = dialog.getByRole('group', { name: legend });
    await group.getByLabel(/^服务器/).fill('127.0.0.1');
    await group.getByLabel(/^端口/).fill(String(port));
    await group.getByRole('radio', { name: '不加密' }).click();
  }
  // Tried before it is kept: a wrong password is refused where it was typed.
  await dialog.getByLabel(/^密码或应用专用密码/).fill('not the password');
  await dialog.getByRole('button', { name: '测试并连接' }).click();
  await expect(dialog.getByRole('alert')).toContainText('没能连上');
  await dialog.getByLabel(/^密码或应用专用密码/).fill(MAILBOX_PASSWORD);
  await dialog.getByRole('button', { name: '测试并连接' }).click();
  await expect(page.getByText('已连接 mei@example.com')).toBeVisible();
  await expect(row).toContainText('已连接');
  await expect(row).toContainText('mei@example.com · 127.0.0.1');

  await open(page, '/');
  await composer(page).fill('check my mailbox');
  await composer(page).press('Enter');
  await expect(page.getByText('Found mail: Invoice 42')).toBeVisible();
  await context.close();
});
