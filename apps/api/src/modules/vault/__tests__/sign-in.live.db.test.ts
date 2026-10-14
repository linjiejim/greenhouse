/**
 * The browser and the vault against the real computer image on a real Docker engine: the Agent
 * opens a sign-in page served inside its computer, finds the login for it and fills it from the
 * vault, then reads the page. The page proves it got the right values (a digest of them) and
 * also echoes the password back in plain text; the model gets the digest and never the password.
 *
 * Opt-in: GREENHOUSE_LIVE_DOCKER=1, with the computer image built (apps/bot-computer).
 */

import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { getDb, messages, runSteps, vaultAccessLog } from '@greenhouse/db';
import { runDocker } from '@greenhouse/providers';
import { scriptedModel, text, toolCall } from '../../../engine/__tests__/model.js';
import { createTestApp } from '../../../testing.js';
import { currentTotp } from '../totp.js';

const live = process.env.GREENHOUSE_LIVE_DOCKER === '1';
const IMAGE = process.env.GREENHOUSE_COMPUTER_IMAGE ?? 'greenhouse/bot-computer:latest';
const ENV = { SANDBOX_PROVIDER: 'docker', SANDBOX_IMAGE: IMAGE, SANDBOX_DOCKER_RUNTIME: 'runc' };

const USERNAME = 'lin.jie@example.com';
const PASSWORD = 'Tr0ub4dor&3-live-horse';
const TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PORT = 8765;
const SITE = `http://localhost:${PORT}`;

/** A sign-in form whose page shows a digest of what it got, and the password itself. */
const PAGE = `<!doctype html>
<html><head><title>Local sign-in</title></head><body>
<h1>Sign in to Local</h1>
<form id="f">
  <label>Email <input name="email" type="email" autocomplete="username"></label>
  <label>Password <input name="password" type="password" autocomplete="current-password"></label>
  <label>Code <input name="otp" autocomplete="one-time-code" inputmode="numeric"></label>
  <button type="submit">Sign in</button>
</form>
<p id="out">Not signed in.</p>
<script>
document.getElementById('f').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  const joined = [data.get('email'), data.get('password'), data.get('otp')].join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(joined));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  document.getElementById('out').textContent = 'Signed in. Proof ' + hex + '. Your password is ' + data.get('password');
});
</script>
</body></html>
`;

const sandboxes: string[] = [];
afterAll(async () => {
  for (const name of sandboxes) {
    await runDocker(['rm', '-f', name]);
    await runDocker(['volume', 'rm', '-f', `${name}-home`]);
  }
});

describe.skipIf(!live)('the browser and the vault, live', () => {
  it('fills a login into a page in the real computer, and the model never sees the password', async () => {
    const scripts: Parameters<typeof scriptedModel>[0] = [];
    const model = scriptedModel(scripts);
    const app = createTestApp(ENV, { languageModel: model.languageModel });
    const lin = await app.member();
    const agent = (await app.call('GET', '/api/agents/main', { token: lin.token })).body;
    sandboxes.push(`gh-cmp-${agent.id.toLowerCase()}`);
    const main = (await app.call('GET', '/api/conversations', { token: lin.token })).body.items[0];

    // The page is served inside the computer, by the Agent's own user.
    const page = Buffer.from(PAGE).toString('base64');
    const written = await app.services.computers.shell(
      lin.id,
      'main',
      `mkdir -p ~/work/site && echo ${page} | base64 -d > ~/work/site/index.html && echo ok`,
    );
    expect(written.output.trim()).toBe('ok');
    await app.services.computers.startJob(
      lin.id,
      'main',
      `cd ~/work/site && exec python3 -m http.server ${PORT} --bind 127.0.0.1`,
      'site',
    );
    const up = await app.services.computers.shell(
      lin.id,
      'main',
      `for i in $(seq 1 50); do curl -sf ${SITE}/ >/dev/null && echo up && exit 0; sleep 0.2; done; exit 1`,
    );
    expect(up.output.trim()).toBe('up');
    // The Agent's shell can never reach the browser's DevTools.
    const reach = await app.services.computers.shell(
      lin.id,
      'main',
      'socat -u OPEN:/dev/null UNIX-CONNECT:/tmp/browser/cdp.sock 2>/dev/null; echo "exit=$?"',
    );
    expect(reach.output.trim()).not.toBe('exit=0');

    const item = (
      await app.call('POST', '/api/me/vault', {
        token: lin.token,
        body: { label: 'Local', origins: [SITE], username: USERNAME, password: PASSWORD, totp: TOTP, policy: 'auto' },
      })
    ).body;
    scripts.push(
      toolCall('browser', { action: 'open', url: `${SITE}/` }, 'call_1'),
      toolCall('vault', { action: 'find' }, 'call_2'),
      toolCall('vault', { action: 'fill', item_id: item.id }, 'call_3'),
      toolCall('browser', { action: 'read' }, 'call_4'),
      text('Signed in.'),
    );
    const sent = await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'sign in to the local site' },
    });
    const started = Date.now();
    await app.services.engine.idle();

    const steps = await getDb()
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, sent.body.run_id), eq(runSteps.kind, 'tool')))
      .orderBy(asc(runSteps.startedAt));
    const [opened, found, filled, read] = steps.map((step) => step.output as any);
    expect(opened).toMatchObject({ url: `${SITE}/`, title: 'Local sign-in' });
    expect(opened.snapshot).toContain('textbox "Password"');
    expect(found).toMatchObject({
      site: SITE,
      logins: [{ id: item.id, label: 'Local', username_hint: 'li***@example.com' }],
    });
    expect(filled).toMatchObject({ filled: ['username', 'password', 'otp'], site: SITE, submitted: true });

    // The page got exactly the login: its digest matches the values and a code of that moment.
    const proofs = [-30_000, 0, 30_000].map((shift) =>
      createHash('sha256')
        .update(`${USERNAME}|${PASSWORD}|${currentTotp(TOTP, started + shift).code}`)
        .digest('hex'),
    );
    const proof = /Proof ([0-9a-f]{64})/.exec(read.text)?.[1];
    expect(proofs).toContain(proof);
    // The page shows the password in plain text; the Agent reads it hidden.
    expect(read.text).toContain('Your password is [hidden]');

    const everything = JSON.stringify([
      model.prompts,
      steps,
      await getDb().select().from(messages).where(eq(messages.conversationId, main.id)).orderBy(asc(messages.seq)),
      await getDb().select().from(vaultAccessLog),
    ]);
    expect(everything).toContain(proof!);
    for (const value of [PASSWORD, TOTP, USERNAME]) expect(everything).not.toContain(value);
    const log = await getDb().select().from(vaultAccessLog).where(eq(vaultAccessLog.memberId, lin.id));
    expect(log.map((row) => [row.outcome, row.approval, row.origin])).toEqual([['filled', 'auto', SITE]]);
  }, 180_000);
});
