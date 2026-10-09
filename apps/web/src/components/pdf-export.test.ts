/**
 * @vitest-environment happy-dom
 *
 * Export PDF and copy-as-HTML carry model output out of the chat. marked passes
 * raw HTML through and the print frame is same-origin, so an injected
 * `<img onerror>` in an answer would run as the member. Needs a real DOM: the
 * sanitizer runs on DOMParser output.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { PRINT_FRAME_SANDBOX, buildPrintDocument, triggerPdfPrint } from './pdf-export';
import { sanitizeExportHtml } from './markdown';

const HOSTILE = [
  '# Quarterly report',
  '',
  'Totals below.',
  '',
  '<img src="x" onerror="parent.localStorage.clear()">',
  '<script>alert(1)</script>',
  '<iframe src="https://evil.example"></iframe>',
  '',
  '[click](javascript:alert(2))',
  '',
  '| Region | Revenue |',
  '| --- | --- |',
  '| North | 42 |',
].join('\n');

afterEach(() => {
  document.body.innerHTML = '';
});

describe('buildPrintDocument', () => {
  it('drops scripts, handlers and javascript: links but keeps the report', () => {
    const html = buildPrintDocument(HOSTILE, 'Report', 'en');

    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toMatch(/<script>alert/i);
    expect(html).not.toContain('evil.example');
    expect(html).toContain('>click</a>');
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).toContain('<h1');
    expect(html).toContain('Quarterly report');
    expect(html).toContain('<table>');
    expect(html).toContain('North');
  });

  it('escapes the title and language it interpolates', () => {
    const html = buildPrintDocument('# Hi', '</title><script>alert(3)</script>', 'en"><script>alert(4)</script>');

    expect(html).not.toContain('<script>alert(3)');
    expect(html).not.toContain('<script>alert(4)');
    expect(html).toContain('&lt;/title&gt;');
  });
});

describe('triggerPdfPrint', () => {
  it('prints from a sandboxed frame that may never run scripts', () => {
    const iframe = triggerPdfPrint(HOSTILE, 'Report', 'en');

    expect(iframe.getAttribute('sandbox')).toBe(PRINT_FRAME_SANDBOX);
    expect(PRINT_FRAME_SANDBOX).not.toContain('allow-scripts');
    expect(iframe.srcdoc).toContain('Quarterly report');
    expect(iframe.srcdoc).not.toMatch(/onerror/i);
  });
});

describe('sanitizeExportHtml', () => {
  it('keeps Markdown structure and strips what the screen renderer strips', () => {
    const html = sanitizeExportHtml('<p>ok <img src="a.png" onerror="x()"><a href="javascript:y()">l</a></p>');

    expect(html).toContain('<p>ok');
    expect(html).toContain('src="a.png"');
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toMatch(/href="javascript:/i);
  });
});
