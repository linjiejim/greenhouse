/**
 * The browser tool against the real computer image on a real Docker engine: a page served
 * inside the computer, read as lines with refs, typed into, clicked, waited on, scrolled, left
 * and come back to, in two tabs, and shown to a model that sees images.
 *
 * Opt-in: GREENHOUSE_LIVE_DOCKER=1, with the computer image built (apps/bot-computer).
 */

import { asc, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { getDb, runSteps } from '@greenhouse/db';
import { runDocker } from '@greenhouse/providers';
import { SHOWN_IMAGE_TEXT } from '../../../engine/history.js';
import { scriptedModel, text, toolCall } from '../../../engine/__tests__/model.js';
import { createTestApp } from '../../../testing.js';

const live = process.env.GREENHOUSE_LIVE_DOCKER === '1';
const IMAGE = process.env.GREENHOUSE_COMPUTER_IMAGE ?? 'greenhouse/bot-computer:latest';
const ENV = { SANDBOX_PROVIDER: 'docker', SANDBOX_IMAGE: IMAGE, SANDBOX_DOCKER_RUNTIME: 'runc' };
const PORT = 8766;
const SITE = `http://localhost:${PORT}`;

const FIRST = `<!doctype html>
<html><head><title>Live page</title></head><body>
<h1>Live page</h1>
<a href="/second.html">Second page</a>
<a href="/second.html" target="_blank">Second in a new tab</a>
<label>Name <input id="name"></label>
<button id="greet" onclick="document.getElementById('out').textContent = 'Hello, ' + document.getElementById('name').value">Greet</button>
<select aria-label="Color"><option value="r">Red</option><option value="g">Green</option></select>
<p id="out"></p>
<div style="height: 3000px">Tall block</div>
<p>Bottom of the page</p>
<script>setTimeout(() => { const late = document.createElement('p'); late.textContent = 'Late text'; document.body.appendChild(late); }, 1500);</script>
</body></html>
`;
const SECOND = '<!doctype html><html><head><title>Second</title></head><body><h1>Second page</h1></body></html>\n';

const sandboxes: string[] = [];
afterAll(async () => {
  for (const name of sandboxes) {
    await runDocker(['rm', '-f', name]);
    await runDocker(['volume', 'rm', '-f', `${name}-home`]);
  }
});

describe.skipIf(!live)('the browser, live', () => {
  it('reads, types, clicks, waits, scrolls, goes back, keeps two tabs and shows a screenshot', async () => {
    const scripts: Parameters<typeof scriptedModel>[0] = [];
    const model = scriptedModel(scripts);
    const app = createTestApp(ENV, {
      languageModel: async () => ({ ...(await model.languageModel()), vision: true }),
    });
    const lin = await app.member();
    const agent = (await app.call('GET', '/api/agents/main', { token: lin.token })).body;
    sandboxes.push(`gh-cmp-${agent.id.toLowerCase()}`);
    const main = (await app.call('GET', '/api/conversations', { token: lin.token })).body.items[0];

    const files = [
      ['index.html', FIRST],
      ['second.html', SECOND],
    ]
      .map(([name, body]) => `echo ${Buffer.from(body!).toString('base64')} | base64 -d > ~/work/live/${name}`)
      .join(' && ');
    expect(
      (await app.services.computers.shell(lin.id, 'main', `mkdir -p ~/work/live && ${files} && echo ok`)).output.trim(),
    ).toBe('ok');
    await app.services.computers.startJob(
      lin.id,
      'main',
      `cd ~/work/live && exec python3 -m http.server ${PORT} --bind 127.0.0.1`,
      'live',
    );
    const up = await app.services.computers.shell(
      lin.id,
      'main',
      `for i in $(seq 1 50); do curl -sf ${SITE}/ >/dev/null && echo up && exit 0; sleep 0.2; done; exit 1`,
    );
    expect(up.output.trim()).toBe('up');

    /** One turn of these browser calls (a turn has at most 11 tool steps); what each returned. */
    const turn = async (calls: Array<Record<string, unknown>>) => {
      scripts.push(...calls.map((input, index) => toolCall('browser', input, `call_${index + 1}`)), text('Done.'));
      const sent = await app.call('POST', `/api/conversations/${main.id}/messages`, {
        token: lin.token,
        body: { content: 'try the live page' },
      });
      await app.services.engine.idle();
      const steps = await getDb()
        .select()
        .from(runSteps)
        .where(eq(runSteps.runId, sent.body.run_id))
        .orderBy(asc(runSteps.startedAt));
      return steps.map((step) => step.output as any);
    };
    const [opened, typed, greeted, waited, scrolled, followed, back, chose] = await turn([
      { action: 'open', url: `${SITE}/` },
      { action: 'type', ref: 'e3', text: 'Lin' },
      { action: 'click', ref: 'e4' },
      { action: 'wait', text: 'Late text', seconds: 10 },
      { action: 'scroll', direction: 'down' },
      { action: 'click', ref: 'e1' },
      { action: 'back' },
      { action: 'type', ref: 'e5', text: 'green' },
    ]);
    const [popup, tabs, switched, closed, pressed, shot, file] = await turn([
      { action: 'snapshot' },
      { action: 'click', ref: 'e2' },
      { action: 'tabs' },
      { action: 'switch_tab', tab: 1 },
      { action: 'close_tab', tab: 2 },
      { action: 'press', key: 'Control+A' },
      { action: 'screenshot' },
      { action: 'open', url: 'file:///etc/passwd' },
    ]).then((outputs) => outputs.slice(1));
    const steps = await getDb().select().from(runSteps);

    expect(opened).toMatchObject({ url: `${SITE}/`, title: 'Live page' });
    expect(opened.snapshot).toContain('- heading h1 "Live page"');
    expect(opened.snapshot).toContain('- link "Second page" [e1]');
    expect(opened.snapshot).toContain('- link "Second in a new tab" [e2]');
    expect(opened.snapshot).toContain('- textbox "Name" [e3]');
    expect(opened.snapshot).toContain('- button "Greet" [e4]');
    expect(typed.snapshot).toContain('- textbox "Name" value="Lin" (focused) [e3]');
    expect(typed.snapshot).not.toContain('- text: Name');
    expect(greeted.snapshot).toContain('Hello, Lin');
    expect(waited.error).toBeUndefined();
    expect(waited.snapshot).toContain('Late text');
    expect(scrolled).toMatchObject({ url: `${SITE}/` });
    expect(followed).toMatchObject({ url: `${SITE}/second.html`, title: 'Second' });
    expect(back).toMatchObject({ url: `${SITE}/`, title: 'Live page' });
    // A dropdown: typing chooses the option with that text.
    expect(back.snapshot).toContain('- combobox "Color" value="Red" (collapsed) [e5]');
    expect(chose.snapshot).toContain('- combobox "Color" value="Green"');
    expect(popup).toMatchObject({
      url: `${SITE}/second.html`,
      note: 'It opened in a new tab, which is now the current one.',
    });
    expect(tabs.tabs).toEqual([
      expect.objectContaining({ tab: 1, url: `${SITE}/`, current: false }),
      expect.objectContaining({ tab: 2, url: `${SITE}/second.html`, current: true }),
    ]);
    expect(switched).toMatchObject({ url: `${SITE}/` });
    expect(closed.tabs).toEqual([expect.objectContaining({ tab: 1, url: `${SITE}/`, current: true })]);
    expect(pressed.error).toBeUndefined();
    expect(shot).toEqual({ url: `${SITE}/`, note: 'The screenshot is shown to you with this result.' });
    expect(file).toMatchObject({ code: 'url_forbidden' });

    // The picture went to the model with its next step, and nowhere else.
    const next = JSON.stringify(model.prompts.at(-1));
    expect(next).toContain(SHOWN_IMAGE_TEXT.slice(0, 40));
    expect(next).toContain('image/jpeg');
    expect(JSON.stringify(steps).length).toBeLessThan(60_000);
    // Nothing holds the screen afterwards.
    const view = await app.call('GET', '/api/agents/main/computer', { token: lin.token });
    expect(view.body.state).toBe('running');
  }, 180_000);
});
