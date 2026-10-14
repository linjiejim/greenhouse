import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { files, getDb, runSteps } from '@greenhouse/db';
import { scriptedModel, text, toolCall } from '../../../engine/__tests__/model.js';
import { createTestApp } from '../../../testing.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function storageEnv() {
  return { STORAGE_PROVIDER: 'local', STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'gh-files-')) };
}

async function upload(
  app: ReturnType<typeof createTestApp>,
  token: string,
  file: File,
  fields: Record<string, string> = {},
) {
  const form = new FormData();
  form.set('file', file);
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const response = await app.app.request('/api/files', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: response.status, body: (await response.json()) as any };
}

describe('files', () => {
  it('stores through the storage provider and serves only to who may read it', async () => {
    const app = createTestApp(storageEnv());
    const lin = await app.member();
    const chen = await app.member();
    const stored = await upload(app, lin.token, new File([PNG], '../../photo.png', { type: 'image/png' }));
    expect(stored.status).toBe(201);
    expect(stored.body).toMatchObject({
      name: 'photo.png',
      content_type: 'image/png',
      size_bytes: PNG.byteLength,
      purpose: 'attachment',
    });
    const [row] = await getDb().select().from(files).where(eq(files.id, stored.body.id));
    expect(row!.storageKey).toMatch(/^attachment\/\d{4}\/\d{2}\/fil_/);
    expect(row!.providerId).toBe('env-storage');

    const content = await app.app.request(stored.body.url, { headers: { authorization: `Bearer ${lin.token}` } });
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toBe('image/png');
    expect(content.headers.get('content-disposition')).toContain('inline');
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(PNG);
    expect((await app.call('GET', `/api/files/${stored.body.id}`, { token: chen.token })).status).toBe(404);

    // A page never renders on our origin.
    const page = await upload(app, lin.token, new File(['<script>alert(1)</script>'], 'x.html', { type: 'text/html' }));
    const served = await app.app.request(page.body.url, { headers: { authorization: `Bearer ${lin.token}` } });
    expect(served.headers.get('content-type')).toBe('application/octet-stream');
    expect(served.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(served.headers.get('content-security-policy')).toContain('sandbox');

    expect((await app.call('DELETE', `/api/files/${stored.body.id}`, { token: chen.token })).status).toBe(404);
    expect((await app.call('DELETE', `/api/files/${stored.body.id}`, { token: lin.token })).status).toBe(204);
    expect((await app.call('GET', `/api/files/${stored.body.id}`, { token: lin.token })).status).toBe(404);
    expect(
      (await upload(app, lin.token, new File(['x'], 'a.txt', { type: 'text/plain' }), { purpose: 'avatar' })).status,
    ).toBe(400);
  });

  it('shares an attachment with the people of the conversation it is sent into', async () => {
    const model = scriptedModel([text('ok')]);
    const app = createTestApp(storageEnv(), { languageModel: model.languageModel });
    const lin = await app.member();
    const chen = await app.member();
    const outsider = await app.member();
    const room = await app.call('POST', '/api/conversations', {
      token: lin.token,
      body: { kind: 'room', member_ids: [chen.id] },
    });
    const stored = await upload(app, lin.token, new File(['notes'], 'notes.txt', { type: 'text/plain' }));
    expect((await app.call('GET', `/api/files/${stored.body.id}`, { token: chen.token })).status).toBe(404);

    // Someone else cannot send my file.
    const stolen = await app.call('POST', `/api/conversations/${room.body.id}/messages`, {
      token: chen.token,
      body: { content: 'look', attachments: [stored.body.id] },
    });
    expect(stolen.status).toBe(400);
    const sent = await app.call('POST', `/api/conversations/${room.body.id}/messages`, {
      token: lin.token,
      body: { content: 'see attached', attachments: [stored.body.id] },
    });
    expect(sent.status).toBe(201);
    expect((await app.call('GET', `/api/files/${stored.body.id}`, { token: chen.token })).body.conversation_id).toBe(
      room.body.id,
    );
    expect((await app.call('GET', `/api/files/${stored.body.id}`, { token: outsider.token })).status).toBe(404);
  });

  it('lets the Agent read a text attachment, and shows images to a model that can see', async () => {
    const scripts: Parameters<typeof scriptedModel>[0] = [];
    const model = scriptedModel(scripts);
    const app = createTestApp(storageEnv(), {
      languageModel: async () => ({ ...(await model.languageModel()), vision: true }),
    });
    const lin = await app.member();
    const main = (await app.call('GET', '/api/conversations', { token: lin.token })).body.items[0];
    const note = await upload(app, lin.token, new File(['hello from the file'], 'hello.txt', { type: 'text/plain' }));
    const picture = await upload(app, lin.token, new File([PNG], 'tiny.png', { type: 'image/png' }));

    scripts.push(toolCall('read_attachment', { file_id: note.body.id }), text('It says hello.'));
    const sent = await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'what does it say?', attachments: [note.body.id] },
    });
    await app.services.engine.idle();
    const [step] = await getDb()
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, sent.body.run_id), eq(runSteps.kind, 'tool')));
    expect(step).toMatchObject({ toolName: 'read_attachment', status: 'succeeded' });
    expect(step!.output).toMatchObject({ name: 'hello.txt', content: 'hello from the file' });

    scripts.push(text('A tiny picture.'));
    await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'and this?', attachments: [picture.body.id] },
    });
    await app.services.engine.idle();
    const prompt = model.prompts.at(-1) as Array<{ role: string; content: unknown }>;
    const last = prompt.filter((message) => message.role === 'user').at(-1);
    expect(JSON.stringify(last)).toContain('image/png');
  });
});
