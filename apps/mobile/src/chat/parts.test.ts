import { describe, expect, it } from 'vitest';
import { askUserAnswer, attachmentsFence, citedObjects, messageImages, pipelineSteps, replyCards, splitAttachments, withMessageParts } from './parts';

describe('a member’s message', () => {
  it('splits the attachments fence from the words', () => {
    const content = '看看这两个\n\n```attachments\n[{"id":"cf_1","name":"a.pdf","size_bytes":2048},{"key":"m/1","name":"old"}]\n```';
    expect(splitAttachments(content)).toEqual({ text: '看看这两个', files: [{ id: 'cf_1', name: 'a.pdf', size: 2048 }] });
    expect(splitAttachments('just words')).toEqual({ text: 'just words', files: [] });
  });

  it('writes the fence the web writes', () => {
    expect(attachmentsFence([{ id: 'cf_1', name: 'a.pdf', size: 3 }])).toBe('```attachments\n[{"id":"cf_1","name":"a.pdf","size_bytes":3}]\n```');
    expect(attachmentsFence([])).toBe('');
  });

  it('reads its pictures from JSON text', () => {
    expect(messageImages('[{"id":"1.jpg","url":"/api/upload/1.jpg"}]')).toEqual([{ id: '1.jpg', url: '/api/upload/1.jpg' }]);
    expect(messageImages('not json')).toEqual([]);
  });
});

describe('a reply’s cards', () => {
  const steps = pipelineSteps(
    JSON.stringify([
      { step: 1, tool: 'knowledge_query', input: {}, output: { results: [] } },
      {
        step: 2,
        tool: 'ask_user',
        input: {},
        output: { type: 'ask_user', title: 'Q', questions: [{ id: 'a', label: 'Size', type: 'single_choice', options: [{ value: 'l', label: 'Large' }] }] },
      },
      { step: 3, tool: 'export_data', output: { type: 'file', file_id: 'cf_9', name: 'x.csv', download_url: '/api/chat-files/cf_9/content', size: 10, row_count: 3 } },
      { step: 4, tool: 'generate_image', output: { success: true, url: '/api/upload/p.png', prompt: 'a plant' } },
      { step: 5, tool: 'capture_task', output: { type: 'task_capture', title: 'Weekly', content: 'do it', variables: [], expected_tools: ['x'] } },
      { step: 6, tool: 'tables_plan', output: { type: 'tables_schema_plan', summary: 'Add a table', operations: [{}] } },
      { step: 7, tool: 'crm_lookup', output: { type: 'crm_customer', title: 'ACME', summary: '3 open deals' } },
      { step: 8, tool: 'kb_create', output: { doc: { id: '12', title: '周报' } } },
    ]),
  );

  it('maps tool outputs to cards like the web', () => {
    const cards = replyCards(steps, 'm1', 'here');
    expect(cards.map((c) => c.kind)).toEqual(['ask_user', 'file', 'image', 'task_capture', 'schema_plan', 'extension']);
    const capture = cards.find((c) => c.kind === 'task_capture');
    expect(capture && 'actionKey' in capture && capture.actionKey).toBe('artifact:m1:5:capture_task');
  });

  it('leaves out a generated image the words already show', () => {
    expect(replyCards(steps, 'm1', '![p](/api/upload/p.png)').some((c) => c.kind === 'image')).toBe(false);
  });

  it('finds the objects a reply cites or wrote, once each', () => {
    const refs = JSON.stringify([{ slug: 'w', title: '周报', type: 'kb_doc', url: '#/knowledge/doc/12-w' }]);
    expect(citedObjects(refs, steps)).toEqual([{ type: 'doc', id: '12', title: '周报' }]);
  });

  it('answers an ask_user card in the web’s words', () => {
    const ask = { title: 'Q', questions: [{ id: 'a', label: 'Size', type: 'single_choice' as const, options: [{ value: 'l', label: 'Large' }] }, { id: 'b', label: 'Note', type: 'text' as const }] };
    expect(askUserAnswer(ask, { a: 'l' })).toBe('Here are my answers to your questions:\n\n**1. Size**: Large (l)\n**2. Note**: (not answered)');
  });
});

describe('a saved message', () => {
  it('reads tool steps, pictures and references from a 3.0 station’s parts object', () => {
    const step = { step: 1, tool: 'ask_user', input: {}, output: { type: 'ask_user', title: 'T', questions: [{ id: 'q', label: 'Q' }] } };
    const message = withMessageParts({
      id: 'm1',
      content: 'hi',
      parts: { pipeline: [step], images: [{ id: 'a', url: '/api/upload/a.jpg' }], references: [{ slug: 's', title: 'S', type: 'wiki' }] },
    } as { id: string; content: string; pipeline?: string | null; images?: string | null; references_?: string | null; parts?: unknown });
    expect(pipelineSteps(message.pipeline).map((s) => s.tool)).toEqual(['ask_user']);
    expect(messageImages(message.images)).toEqual([{ id: 'a', url: '/api/upload/a.jpg' }]);
    expect(JSON.parse(message.references_ ?? '[]')).toEqual([{ slug: 's', title: 'S', type: 'wiki' }]);
  });

  it('keeps the JSON-text columns an older station sends', () => {
    const message = { id: 'm2', pipeline: '[]', parts: { pipeline: [{ step: 1, tool: 'x' }] } };
    expect(withMessageParts(message).pipeline).toBe('[]');
    const plain = { id: 'm3', pipeline: null };
    expect(withMessageParts(plain)).toBe(plain);
  });
});
