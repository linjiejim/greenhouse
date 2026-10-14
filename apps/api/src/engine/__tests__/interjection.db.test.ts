import { describe, expect, it, vi } from 'vitest';
import { createTestApp } from '../../testing.js';
import { gate, lastUserText, scriptedModel, text } from './model.js';

describe('step-boundary interjections', () => {
  it('splits the reply without changing the member’s seq and continues in the same run', async () => {
    const hold = gate();
    const model = scriptedModel([
      { parts: text('First part.'), gate: hold.promise },
      text('With the new information.'),
    ]);
    const app = createTestApp({}, { languageModel: model.languageModel });
    const member = await app.member();
    const main = (await app.call('GET', '/api/conversations', { token: member.token })).body.items[0];
    const sent = await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: member.token,
      body: { content: 'Begin' },
    });
    // Wait for the model to begin, so the initial reply precedes the interjection.
    await vi.waitFor(() => expect(model.calls()).toBe(1));
    const extra = await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: member.token,
      body: { content: 'Use this detail' },
    });
    hold.open();
    await app.services.engine.idle();
    const all = (await app.call('GET', `/api/conversations/${main.id}/messages`, { token: member.token })).body.items;
    const message = all.find((item: { id: string }) => item.id === extra.body.message.id);
    expect(message.seq).toBe(extra.body.message.seq);
    expect(message.event).toMatchObject({ type: 'interjection', state: 'incorporated', run_id: sent.body.run_id });
    const replies = all.filter(
      (item: { run_id: string; role: string }) => item.run_id === sent.body.run_id && item.role === 'assistant',
    );
    expect(replies.map((item: { content: string }) => item.content)).toEqual([
      'First part.',
      'With the new information.',
    ]);
    expect(replies[0].seq).toBeLessThan(message.seq);
    expect(replies[1].seq).toBeGreaterThan(message.seq);
    expect(lastUserText(model.prompts[1])).toContain('Use this detail');
  });
  it('keeps another member’s room message queued while incorporating the asker’s message', async () => {
    const hold = gate();
    const model = scriptedModel([
      { parts: text('First.'), gate: hold.promise },
      text('Asker continuation.'),
      text('Other member reply.'),
    ]);
    const app = createTestApp({}, { languageModel: model.languageModel });
    const asker = await app.member();
    const other = await app.member();
    const room = await app.services.conversations.create(asker.id, {
      kind: 'room',
      member_ids: [other.id],
      agent_ids: ['main'],
    });
    await app.services.conversations.addMembers(other.id, room.id, { member_ids: [], agent_ids: ['main'] });
    const post = (memberId: string, content: string) =>
      app.services.engine.post(memberId, room.id, { content, attachments: [], mentions: ['main'] });
    const first = await post(asker.id, 'Begin');
    await vi.waitFor(() => expect(model.calls()).toBe(1));
    const queued = await post(other.id, 'Other member detail');
    const inserted = await app.services.engine.post(asker.id, room.id, {
      content: 'Asker detail',
      attachments: [],
      mentions: [],
    });
    hold.open();
    await app.services.engine.idle();
    const page = await app.services.conversations.messages(asker.id, room.id, { limit: 50 });
    expect(page.items.find((m) => m.id === inserted.message.id)?.event).toMatchObject({
      state: 'incorporated',
      run_id: first.run_id,
    });
    expect(page.items.find((m) => m.id === queued.message.id)?.event?.state).not.toBe('incorporated');
    expect(lastUserText(model.prompts[1])).toContain('Asker detail');
    expect(lastUserText(model.prompts[1])).not.toContain('Other member detail');
    expect(page.items.filter((m) => m.role === 'assistant' && m.run_id === first.run_id)).toHaveLength(2);
    expect(model.calls()).toBe(3);
  });
});
