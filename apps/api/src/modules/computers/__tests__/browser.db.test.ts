/**
 * The browser tool (AGNT-22) in a turn, against a fake browser on the fake computer: pages read
 * as lines with refs, clicks and typing, the addresses it refuses, vault values hidden from what
 * it reads, screenshots for a model that sees images, and one controller at a time.
 */

import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentComputers, getDb, runSteps } from '@greenhouse/db';
import { SHOWN_IMAGE_TEXT } from '../../../engine/history.js';
import { scriptedModel, text, toolCall } from '../../../engine/__tests__/model.js';
import { createTestApp } from '../../../testing.js';
import { axPage, FakeChromium, type FakePage } from './fake-chromium.js';
import { fake, fakeSandboxEnv } from './fake-sandbox.js';

const SHOP = 'https://shop.example.com/';
const PASSWORD = 'Tr0ub4dor&3-horse-staple';

const PAGES: Record<string, FakePage> = {
  [SHOP]: {
    title: 'Shop',
    text: 'Shop home',
    ax: axPage('Shop', [
      { role: 'heading', name: 'Shop' },
      { role: 'link', name: 'Orders', node: 21 },
      { role: 'textbox', name: 'Search', node: 22 },
      { role: 'textbox', name: 'Password', node: 23 },
      { role: 'button', name: 'Go', node: 24 },
    ]),
    attributes: { 23: ['type', 'password'] },
    onClick: 'https://shop.example.com/orders',
  },
  'https://shop.example.com/orders': {
    title: 'Orders',
    text: 'Order 1001 shipped',
    ax: axPage('Orders', [{ role: 'heading', name: 'Your orders' }]),
  },
  'https://shop.example.com/account': {
    title: 'Account',
    text: `Your password is ${PASSWORD}`,
    ax: axPage('Account', [{ role: 'textbox', name: 'Password', node: 31, value: PASSWORD }]),
  },
};

type Scripts = Parameters<typeof scriptedModel>[0];

async function setup(start = SHOP, options: { vision?: boolean } = {}) {
  const scripts: Scripts = [];
  const model = scriptedModel(scripts);
  const app = createTestApp(fakeSandboxEnv(), {
    languageModel: async () => ({ ...(await model.languageModel()), ...(options.vision ? { vision: true } : {}) }),
  });
  const chromium = new FakeChromium(PAGES, start);
  fake.onStream = (stream) => {
    if (stream.kind === 'devtools') chromium.attach(stream);
  };
  const lin = await app.member();
  const main = (await app.call('GET', '/api/conversations', { token: lin.token })).body.items[0];
  /** One turn playing these calls; what each step returned. */
  const turn = async (...calls: Array<Record<string, unknown>>) => {
    scripts.push(
      ...calls.map((input, index) => toolCall('browser', input, `call_${scripts.length + index}`)),
      text('ok'),
    );
    const sent = await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'go' },
    });
    await app.services.engine.idle();
    return (
      await getDb()
        .select()
        .from(runSteps)
        .where(and(eq(runSteps.runId, sent.body.run_id), eq(runSteps.kind, 'tool')))
        .orderBy(asc(runSteps.startedAt))
    ).map((row) => row.output as any);
  };
  const computer = async () => {
    await app.services.computers.ensure(lin.id, 'main');
    return (await getDb().select().from(agentComputers).where(eq(agentComputers.ownerId, lin.id)))[0]!;
  };
  return { ...app, model, chromium, lin, main, turn, computer };
}

describe('the browser tool', () => {
  it('opens a page, reads it with refs, types and clicks, and never types a password', async () => {
    const env = await setup('about:blank');
    const [opened, password, typed, clicked, read] = await env.turn(
      { action: 'open', url: 'shop.example.com' },
      { action: 'type', ref: 'e3', text: 'guess' },
      { action: 'type', ref: 'e2', text: 'socks' },
      { action: 'click', ref: 'e1' },
      { action: 'read' },
    );
    expect(opened).toMatchObject({ url: SHOP, title: 'Shop' });
    expect(opened.snapshot.split('\n')).toEqual([
      '- heading "Shop"',
      '- link "Orders" [e1]',
      '- textbox "Search" [e2]',
      '- textbox "Password" [e3]',
      '- button "Go" [e4]',
    ]);
    expect(password).toMatchObject({ code: 'secret_field' });
    expect(typed).toMatchObject({ url: SHOP });
    expect(env.chromium.typed).toEqual(['socks']);
    expect(clicked).toMatchObject({ url: 'https://shop.example.com/orders', title: 'Orders' });
    expect(clicked.snapshot).toBe('- heading "Your orders"');
    expect(read).toEqual({ url: 'https://shop.example.com/orders', text: 'Order 1001 shipped' });
    expect(env.chromium.clicks).toBe(1);
    // Each action is its own connection, and the screen is free again afterwards.
    expect(env.chromium.connections).toBe(5);
    expect((await env.computer()).leaseHolder).toBeNull();
  });

  it('refuses addresses it must not open, and leaves a page it must not read', async () => {
    const env = await setup('chrome://settings/');
    const [file, own, stale, settings] = await env.turn(
      { action: 'open', url: 'file:///etc/passwd' },
      { action: 'open', url: 'http://greenhouse.test/#/agents' },
      { action: 'click', ref: 'e1' },
      { action: 'snapshot' },
    );
    expect(file).toMatchObject({ code: 'url_forbidden' });
    expect(own).toMatchObject({ code: 'url_forbidden' });
    expect(stale).toMatchObject({ code: 'ref_stale' });
    expect(settings).toMatchObject({ code: 'url_forbidden' });
    expect(env.chromium.current.url).toBe('about:blank');
    expect(env.chromium.methods.filter((method) => method === 'Page.navigate')).toHaveLength(1);
  });

  it('hides the vault’s values from what it reads, and takes no screenshot of them', async () => {
    const env = await setup('https://shop.example.com/account', { vision: true });
    await env.call('POST', '/api/me/vault', {
      token: env.lin.token,
      body: { label: 'Shop', origins: ['https://shop.example.com'], password: PASSWORD },
    });
    const [snapshot, read, shot, opened, clean] = await env.turn(
      { action: 'snapshot' },
      { action: 'read' },
      { action: 'screenshot' },
      { action: 'open', url: SHOP },
      { action: 'screenshot' },
    );
    expect(snapshot.snapshot).toBe('- textbox "Password" value="[hidden]" [e1]');
    expect(read.text).toBe('Your password is [hidden]');
    expect(shot).toMatchObject({ code: 'secret_visible' });
    expect(opened.url).toBe(SHOP);
    expect(clean).toEqual({ url: SHOP, note: 'The screenshot is shown to you with this result.' });
    // The picture reaches the model with the next step, as a system line, and is kept nowhere.
    const next = JSON.stringify(env.model.prompts.at(-1));
    expect(next).toContain(SHOWN_IMAGE_TEXT.slice(0, 40));
    expect(next).toContain('image/jpeg');
    const stored = JSON.stringify(await getDb().select().from(runSteps));
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain(Buffer.from('fake jpeg bytes').toString('base64'));
  });

  it('says so when the model cannot see a screenshot', async () => {
    const env = await setup();
    const [shot] = await env.turn({ action: 'screenshot' });
    expect(shot.status).toBe('unsupported');
    expect(shot.note).toContain('No screenshot was taken');
    expect(shot.note).toContain('cannot see images');
    expect(env.chromium.methods).not.toContain('Page.captureScreenshot');
    const transcript = await env.call('GET', `/api/conversations/${env.main.id}/messages`, { token: env.lin.token });
    expect(transcript.body.items.at(-1).steps[0].summary).toBe('模型不支持查看截图');
  });

  it('keeps tabs numbered, switches and closes them', async () => {
    const env = await setup();
    const [opened, tabs, switched, closed] = await env.turn(
      { action: 'open', url: 'https://shop.example.com/orders', new_tab: true },
      { action: 'tabs' },
      { action: 'switch_tab', tab: 1 },
      { action: 'close_tab', tab: 2 },
    );
    expect(opened).toMatchObject({ url: 'https://shop.example.com/orders', note: 'Opened in a new tab.' });
    expect(tabs.tabs).toEqual([
      { tab: 1, title: 'Shop', url: SHOP, current: false },
      { tab: 2, title: 'Orders', url: 'https://shop.example.com/orders', current: true },
    ]);
    expect(switched.url).toBe(SHOP);
    expect(closed.tabs).toEqual([{ tab: 1, title: 'Shop', url: SHOP, current: true }]);
  });

  it('gives way to the member: never acts while they control the screen, and drops what it read when they take over', async () => {
    const env = await setup();
    const computer = await env.computer();

    // Taking over through the screen socket holds the screen until it closes.
    const { ticket } = await env.services.computers.ticket(env.lin.id, 'main', 'control');
    const screen = await env.services.computers.open(ticket, 'screen');
    expect(screen.control).toBeDefined();
    expect((await env.computer()).leaseController).toBe('member');
    const [refused] = await env.turn({ action: 'snapshot' });
    expect(refused).toMatchObject({ code: 'member_in_control' });
    expect(env.chromium.connections).toBe(0);
    await screen.control!.release();
    screen.stream.kill();
    expect((await env.computer()).leaseController).toBeNull();

    // Taken over in the middle of a click: nothing it read comes back.
    env.chromium.onClick = () => env.services.computers.claimScreen(computer.id, 'ctl_late', 'member', 60_000);
    const [, interrupted] = await env.turn({ action: 'snapshot' }, { action: 'click', ref: 'e1' });
    expect(interrupted).toMatchObject({ code: 'member_in_control' });
    expect(interrupted.snapshot).toBeUndefined();
    expect(interrupted.error).toContain('took over the screen');
  }, 20_000);
});
