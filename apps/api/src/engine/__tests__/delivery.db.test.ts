/** A needs-you card from a real turn leaves through the member's channels: email and push. */

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, jobs } from '@greenhouse/db';
import {
  EXPO_TOKEN,
  fakeNetwork,
  PROJECT_ID,
  readMail,
  smtpInstance,
  startFakeSmtp,
  type FakeSmtp,
} from '../../modules/channels/__tests__/fakes.js';
import { createTestApp } from '../../testing.js';
import { defineTool } from '../tools/define.js';
import { scriptedModel, text, toolCall } from './model.js';

let smtp: FakeSmtp | null = null;
afterEach(async () => {
  await smtp?.close();
  smtp = null;
});

const noteTool = defineTool({
  name: 'note_write',
  description: 'Write a note into the shared notebook.',
  input: z.object({ text: z.string() }),
  risk: 'write',
  describe: (args, ctx) => ({
    summary: ctx.locale === 'zh' ? `写一条笔记「${args.text}」` : `write the note "${args.text}"`,
    details: [{ label: 'text', value: args.text }],
  }),
  async execute() {
    return { written: true };
  },
});

describe('a needs-you card', () => {
  it('reaches email and push for a member who opted in, without what it asks', async () => {
    smtp = await startFakeSmtp();
    const net = fakeNetwork();
    const model = scriptedModel([toolCall('note_write', { text: '工资单' }), text('Written.')]);
    const { call, services, member } = createTestApp(
      { PUSH_PROVIDER: 'expo' },
      { languageModel: model.languageModel, tools: [noteTool], fetch: net.fetch },
    );
    const admin = await member('admin');
    const lin = await member('member', 'lin@acme.com');
    await smtpInstance(call, admin.token, {
      host: '127.0.0.1',
      port: smtp.port,
      security: 'none',
      fromAddress: 'gh@acme.com',
    });
    // Lin opts in to email; push is on by default once the phone is registered.
    await call('PUT', '/api/me/notification-settings', {
      token: lin.token,
      body: { categories: { needs_you: { email: true } } },
    });
    await call('PUT', '/api/me/push-devices', {
      token: lin.token,
      body: { token: EXPO_TOKEN(), platform: 'ios', project_id: PROJECT_ID, client_ref: 'station-a' },
    });

    const main = (await call('GET', '/api/conversations', { token: lin.token })).body.items[0];
    await call('POST', `/api/conversations/${main.id}/messages`, { token: lin.token, body: { content: '记一下' } });
    await services.engine.idle();
    const card = (await call('GET', '/api/requests', { token: lin.token })).body.items[0];
    expect(card).toMatchObject({ kind: 'approval', status: 'pending', conversation_id: main.id });

    expect(await services.channels.runOnce()).toBe(2);
    expect(smtp.mails).toHaveLength(1);
    const mail = await readMail(smtp.mails[0]!);
    expect(mail.to).toEqual(['lin@acme.com']);
    expect(mail.subject).toBe('Greeny：请你批准一个操作');
    expect(mail.text).toContain(`http://greenhouse.test/#/c/${main.id}`);
    expect(`${mail.subject}${mail.text}${mail.html}`).not.toContain('工资单');

    expect(net.state.pushes).toEqual([
      expect.objectContaining({
        to: EXPO_TOKEN(),
        title: 'Greeny',
        body: '请你批准一个操作',
        badge: 1,
        interruptionLevel: 'time-sensitive',
        data: {
          v: 1,
          s: 'station-a',
          u: lin.id,
          k: 'needs_you',
          nid: expect.stringMatching(/^ntf_/),
          sid: main.id,
          rid: card.id,
          url: `/c/${main.id}`,
        },
      }),
    ]);
    expect(JSON.stringify(net.state.pushes)).not.toContain('工资单');
    // The push lasts as long as the card does.
    expect(net.state.pushes[0]!.expiration).toBe(Math.floor(Date.parse(card.expires_at) / 1000));

    // One delivery per channel, each done.
    const queued = await getDb().select().from(jobs).where(eq(jobs.kind, 'deliver_notification'));
    expect(queued.map((job) => [job.payload.channel, job.status]).sort()).toEqual([
      ['email', 'succeeded'],
      ['push', 'succeeded'],
    ]);
  });
});
