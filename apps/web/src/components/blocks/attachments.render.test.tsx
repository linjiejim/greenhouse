/**
 * Mission input chips: the server writes a ```mission-attachments fence into
 * the user turn, and the bubble must show the prompt as text with the files as
 * pills — never the raw JSON.
 *
 * Rendering is asserted through renderToStaticMarkup (no DOM), so behaviour
 * that needs clicks is covered at the split/parse level instead.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { splitAttachments } from './index.js';
import { AttachmentsBlock, isSafeAttachmentPreview } from './attachments-block.js';

const KEY = 'cloud-agent/attachments/u-1/abc/ECT说明书.pdf';
const fence = (payload: unknown) => '```mission-attachments\n' + JSON.stringify(payload) + '\n```';

describe('splitMissionAttachments', () => {
  it('lifts the fence out of the user text', () => {
    const { text, attachments } = splitAttachments(
      '按 skill 审校这份说明书\n\n' + fence([{ key: KEY, name: 'ECT说明书.pdf', size_bytes: 2_700_000 }]),
    );
    expect(text).toBe('按 skill 审校这份说明书');
    expect(attachments).toEqual([{ key: KEY, name: 'ECT说明书.pdf', size_bytes: 2_700_000 }]);
  });

  it('leaves ordinary user messages byte-identical', () => {
    const plain = 'just a question\n\n```js\nconst a = 1;\n```';
    expect(splitAttachments(plain)).toEqual({ text: plain, attachments: [] });
  });

  it('keeps a malformed fence visible instead of eating the message', () => {
    const broken = 'do this\n\n```mission-attachments\n{not json\n```';
    const { text, attachments } = splitAttachments(broken);
    expect(text).toBe(broken);
    expect(attachments).toEqual([]);
  });

  it('drops items with no downloadable key rather than rendering dead pills', () => {
    const { attachments } = splitAttachments(fence([{ name: 'orphan.pdf' }, { key: KEY, name: 'ok.pdf' }]));
    expect(attachments).toEqual([{ key: KEY, name: 'ok.pdf' }]);
  });
});

describe('MissionAttachmentsBlock', () => {
  it('renders one pill per file with its name and size', () => {
    const html = renderToStaticMarkup(
      createElement(AttachmentsBlock, {
        data: [
          { key: KEY, name: 'ECT说明书.pdf', size_bytes: 2_700_000 },
          { key: `${KEY}2`, name: 'notes.txt', size_bytes: 512 },
        ],
      }),
    );
    expect(html).toContain('ECT说明书.pdf');
    expect(html).toContain('2.6 MB');
    expect(html).toContain('notes.txt');
    expect(html).toContain('512 B');
    expect(html).toContain('rounded-full');
  });

  it('renders nothing when there are no attachments', () => {
    expect(renderToStaticMarkup(createElement(AttachmentsBlock, { data: [] }))).toBe('');
  });
});

describe('attachment preview MIME boundary', () => {
  it('allows only explicit inert image/PDF media types', () => {
    expect(isSafeAttachmentPreview('image', 'image/png')).toBe(true);
    expect(isSafeAttachmentPreview('pdf', 'application/pdf; charset=binary')).toBe(true);
    expect(isSafeAttachmentPreview('image', 'text/html')).toBe(false);
    expect(isSafeAttachmentPreview('image', 'image/svg+xml')).toBe(false);
    expect(isSafeAttachmentPreview('pdf', 'text/html')).toBe(false);
  });
});
