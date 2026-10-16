import { eq, sql } from 'drizzle-orm';
import { getDb, jobs } from '@greenhouse/db';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing.js';
import { scriptedModel, text, toolCall } from '../../../engine/__tests__/model.js';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const MP4 = Uint8Array.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
const env = { IMAGE_PROVIDER: '302ai', IMAGE_API_KEY: 'test-key', VIDEO_PROVIDER: '302ai', VIDEO_API_KEY: 'test-key' };

describe('generated media', () => {
  it('returns a metered image artifact in the reply and saves it to the member’s knowledge', async () => {
    const model = scriptedModel([toolCall('generate_image', { prompt: 'a sprout' }), text('Here it is.')]);
    const app = createTestApp(env, {
      languageModel: model.languageModel,
      fetch: async () =>
        new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), {
          headers: { 'content-type': 'application/json' },
        }),
    });
    const member = await app.member();
    const main = (await app.call('GET', '/api/conversations', { token: member.token })).body.items[0];
    await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: member.token,
      body: { content: 'Make an image' },
    });
    await app.services.engine.idle();
    const reply = (
      await app.call('GET', `/api/conversations/${main.id}/messages`, { token: member.token })
    ).body.items.at(-1);
    expect(reply.attachments).toHaveLength(1);
    const file = await app.services.files.view(member.id, reply.attachments[0]);
    expect(file.content_type).toBe('image/png');
    const saved = await app.call('POST', `/api/media/files/${file.id}/save`, {
      token: member.token,
      body: { space: 'personal' },
    });
    expect(saved.status).toBe(201);
    expect((await app.services.knowledge.file(member.id, saved.body.id)).name).toBe(file.name);
    const other = await app.member();
    expect(
      (await app.call('POST', `/api/media/files/${file.id}/save`, { token: other.token, body: { space: 'personal' } }))
        .status,
    ).toBe(404);
  });
  it(
    'creates video work only after approval, polls it on jobs, and reports a video artifact',
    { timeout: 15000 },
    async () => {
      const model = scriptedModel([
        toolCall('generate_video', { prompt: 'a sprout moving', seconds: 4 }),
        text('Waiting.'),
        text('Video queued.'),
      ]);
      const app = createTestApp(env, {
        languageModel: model.languageModel,
        fetch: async (input, init) => {
          const url = String(input);
          if (url.includes('/content')) return new Response(MP4, { headers: { 'content-type': 'video/mp4' } });
          return new Response(
            JSON.stringify({
              id: 'v1',
              status: init?.method === 'POST' ? 'queued' : 'completed',
              progress: init?.method === 'POST' ? 0 : 100,
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        },
      });
      const member = await app.member();
      const main = (await app.call('GET', '/api/conversations', { token: member.token })).body.items[0];
      await app.call('POST', `/api/conversations/${main.id}/messages`, {
        token: member.token,
        body: { content: 'Make a video' },
      });
      await app.services.engine.idle();
      expect((await app.services.runs.list(member.id, { state: 'all', limit: 50 })).items).toHaveLength(0);
      const card = (await app.call('GET', '/api/requests', { token: member.token })).body.items[0];
      const approved = await app.call('POST', `/api/requests/${card.id}/approve`, { token: member.token, body: {} });
      expect(approved.status).toBe(200);
      await app.services.engine.idle();
      await app.services.tables.worker.drain();
      const run = (await app.services.runs.list(member.id, { state: 'all', limit: 50 })).items[0];
      expect(run.status).toBe('running');
      await getDb()
        .update(jobs)
        .set({ availableAt: sql`now()` })
        .where(eq(jobs.kind, 'media_video'));
      await app.services.tables.worker.drain();
      const result = await app.services.runs.get(member.id, run.id);
      expect(result.status).toBe('succeeded');
      expect(result.file_ids).toHaveLength(1);
    },
  );
  it('does not replay a video submission whose result was lost', async () => {
    let submissions = 0;
    const model = scriptedModel([
      toolCall('generate_video', { prompt: 'a sprout', seconds: 4 }),
      text('Waiting.'),
      text('Queued.'),
    ]);
    const app = createTestApp(env, {
      languageModel: model.languageModel,
      fetch: async () => {
        submissions += 1;
        throw new Error('connection lost after submission');
      },
    });
    const member = await app.member();
    const main = await app.services.conversations.ensureMain(member.id);
    await app.services.engine.post(member.id, main.id, { content: 'Make video', attachments: [], mentions: [] });
    await app.services.engine.idle();
    const card = (await app.call('GET', '/api/requests', { token: member.token })).body.items[0];
    await app.call('POST', `/api/requests/${card.id}/approve`, { token: member.token, body: {} });
    await app.services.engine.idle();
    await app.services.tables.worker.drain();
    const run = (await app.services.runs.list(member.id, { state: 'all', limit: 50 })).items[0]!;
    expect(run.error?.code).toBe('video_submission_uncertain');
    await app.services.tables.worker.drain();
    expect(submissions).toBe(1);
    expect((await app.call('POST', `/api/runs/${run.id}/retry`, { token: member.token })).status).toBe(409);
  });
  it('rechecks the binding before submitting a queued video', async () => {
    let submissions = 0;
    const model = scriptedModel([
      toolCall('generate_video', { prompt: 'a sprout', seconds: 4 }),
      text('Waiting.'),
      text('Queued.'),
    ]);
    const app = createTestApp(env, {
      languageModel: model.languageModel,
      fetch: async () => {
        submissions += 1;
        throw new Error('Should not reach the disabled service');
      },
    });
    const member = await app.member('admin');
    const main = await app.services.conversations.ensureMain(member.id);
    await app.services.engine.post(member.id, main.id, { content: 'Make video', attachments: [], mentions: [] });
    await app.services.engine.idle();
    const card = (await app.call('GET', '/api/requests', { token: member.token })).body.items[0];
    await app.call('POST', `/api/requests/${card.id}/approve`, { token: member.token, body: {} });
    await app.services.engine.idle();
    await app.call('PUT', '/api/admin/provider-bindings/video', { token: member.token, body: { instance_ids: [] } });
    await app.services.tables.worker.drain();
    const run = (await app.services.runs.list(member.id, { state: 'all', limit: 50 })).items[0]!;
    expect(run.error?.code).toBe('video_not_configured');
    expect(submissions).toBe(0);
  });
});
