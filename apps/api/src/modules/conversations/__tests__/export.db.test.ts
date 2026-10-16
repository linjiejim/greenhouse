import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { files, getDb, members, messages, newId } from '@greenhouse/db';
import { filenameOf } from '@greenhouse/contract/client';
import { createTestApp } from '../../../testing.js';
import { exportFilename, formatTime } from '../export.js';

describe('exporting a conversation', () => {
  it('writes the title, every message with its author and time, events, steps and file names, and no ids', async () => {
    const { app, call, services, member } = createTestApp();
    const lin = await member();
    await getDb()
      .update(members)
      .set({ name: 'Lin', locale: 'en', timezone: 'Asia/Shanghai' })
      .where(eq(members.id, lin.id));
    const agent = (await call('GET', '/api/agents/main', { token: lin.token })).body;
    const chat = await call('POST', '/api/conversations', {
      token: lin.token,
      body: { kind: 'chat', title: 'Trip: Kyoto/Osaka "2026"' },
    });
    const fileId = newId('file');
    await getDb()
      .insert(files)
      .values({
        id: fileId,
        purpose: 'attachment',
        providerId: 'builtin-storage',
        storageKey: `attachment/test/${fileId}`,
        name: 'plan.pdf',
        contentType: 'application/pdf',
        status: 'active',
        ownerId: lin.id,
        conversationId: chat.body.id,
      });
    const asked = await services.conversations.append(chat.body.id, {
      role: 'user',
      authorMemberId: lin.id,
      content: 'Where should we stay?',
      attachments: [fileId],
    });
    await getDb().update(messages).set({ createdAt: '2026-10-13T08:05:00Z' }).where(eq(messages.id, asked.id));
    await services.conversations.append(chat.body.id, {
      role: 'assistant',
      agentId: agent.id,
      content: 'Try a **ryokan**.',
      quote: { messageId: asked.id, text: 'Where should we stay?' },
      steps: [
        { tool: 'web_search', summary: 'Searched the web', status: 'done' },
        { tool: 'web_fetch', summary: 'Read a page', status: 'failed' },
      ],
    });
    await services.conversations.append(chat.body.id, {
      role: 'event',
      agentId: agent.id,
      content: 'Approved: book *the* hotel',
      event: { type: 'decision' },
    });

    const response = await app.request(`/api/conversations/${chat.body.id}/export`, {
      headers: { authorization: `Bearer ${lin.token}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    const disposition = response.headers.get('content-disposition');
    expect(disposition).toMatch(/^attachment; filename="Trip Kyoto Osaka 2026\.md"/);
    expect(filenameOf(disposition)).toBe('Trip Kyoto Osaka 2026.md');
    const markdown = await response.text();
    const lines = markdown.split('\n');
    expect(lines[0]).toBe('# Trip: Kyoto/Osaka "2026"');
    expect(lines[2]).toMatch(/^Exported \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(Asia\/Shanghai\)$/);
    expect(lines.slice(4)).toEqual([
      '**Lin** · 2026-10-13 16:05',
      '',
      'Where should we stay?',
      '',
      'Attachments: plan.pdf',
      '',
      expect.stringMatching(/^\*\*Greeny\*\* · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
      '',
      '> Where should we stay?',
      '',
      'Try a **ryokan**.',
      '',
      '- Searched the web',
      '- Read a page (failed)',
      '',
      '*Approved: book \\*the\\* hotel*',
      '',
    ]);
    expect(markdown).not.toMatch(/\b(msg|cnv|agt|mbr|fil|run)_[0-9A-Z]{26}\b/);
  });

  it('names an untitled conversation after its Agent, in the reader’s language, and only for its people', async () => {
    const { app, call, member } = createTestApp();
    const lin = await member();
    const chen = await member();
    const chat = await call('POST', '/api/conversations', { token: lin.token, body: { kind: 'chat' } });
    const response = await app.request(`/api/conversations/${chat.body.id}/export`, {
      headers: { authorization: `Bearer ${lin.token}` },
    });
    expect(filenameOf(response.headers.get('content-disposition'))).toBe('Greeny.md');
    expect((await response.text()).split('\n').slice(0, 3)).toEqual([
      '# Greeny',
      '',
      expect.stringMatching(/^导出于 .* \(Asia\/Shanghai\)$/),
    ]);
    const outsider = await app.request(`/api/conversations/${chat.body.id}/export`, {
      headers: { authorization: `Bearer ${chen.token}` },
    });
    expect(outsider.status).toBe(404);
  });

  it('makes a file name every system accepts', () => {
    expect(exportFilename('a/b\\c:d*e?f"g<h>i|j', 'x')).toBe('a b c d e f g h i j.md');
    expect(exportFilename(' ..hidden.. ', 'x')).toBe('hidden.md');
    expect(exportFilename('\u0007', '对话')).toBe('对话.md');
    expect(exportFilename('长'.repeat(200), 'x')).toBe(`${'长'.repeat(80)}.md`);
    expect(formatTime('2026-10-13T23:30:00Z', 'Not/AZone')).toBe('2026-10-13 23:30');
  });
});
