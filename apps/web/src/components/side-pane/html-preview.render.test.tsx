/**
 * @vitest-environment happy-dom
 *
 * The sandbox attributes are the security boundary for the only place in the
 * app that runs HTML it did not author, so they get an explicit regression
 * test rather than relying on a code comment.
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HtmlPreview, PRINT_SANDBOX } from './html-preview';

const PAGE = '<!doctype html><html><head><title>Calc</title></head><body><script>alert(1)</script></body></html>';

describe('HtmlPreview isolation', () => {
  const html = renderToStaticMarkup(<HtmlPreview code={PAGE} title="Calc" />);

  it('runs the document in a sandboxed iframe', () => {
    expect(html).toContain('sandbox="allow-scripts"');
    // React's static markup spells it `srcDoc`; HTML attribute names are
    // case-insensitive, so the browser sees `srcdoc` either way.
    expect(html.toLowerCase()).toContain('srcdoc=');
  });

  it('never grants same-origin, which would defeat the sandbox entirely', () => {
    // allow-scripts + allow-same-origin together is equivalent to no sandbox:
    // the document could then read this session's storage and tokens.
    expect(html).not.toContain('allow-same-origin');
    expect(html).not.toContain('allow-forms');
    expect(html).not.toContain('allow-popups');
    expect(html).not.toContain('allow-modals');
  });

  it('offers no path that would run the document on this origin', () => {
    // A blob: URL inherits the creating page's origin, so "open in new tab"
    // would be the same hole with a friendlier label.
    expect(html).not.toContain('blob:');
    expect(html).not.toContain('target="_blank"');
  });

  it('renders no chrome of its own — the pane header is the toolbar', () => {
    // The duplicated title row this replaced said the same thing twice and
    // cost a row of a column that is 360px at its narrowest. The title now
    // survives only as the frame's accessible name, never as a second label.
    expect(html).not.toContain('<span');
    // Portalled controls have no host in static markup, so nothing but the
    // frame should survive this render.
    expect(html).not.toContain('<button');
  });
});

describe('HtmlPreview PDF export frame', () => {
  /**
   * The print frame only exists mid-export, so it never appears in a static
   * render. It is the one place a second set of sandbox tokens is allowed to
   * exist, and the point of the test is that `allow-modals` — which is what
   * opens the print dialog — never arrives alongside same-origin.
   */
  it('keeps the print frame on an opaque origin', () => {
    const tokens = PRINT_SANDBOX.split(' ');

    expect(tokens).toContain('allow-scripts');
    expect(tokens).toContain('allow-modals');
    expect(tokens).not.toContain('allow-same-origin');
  });
});
