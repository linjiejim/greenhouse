/**
 * Render-level regression test for the trace-vs-artifact split (a rich card once
 * rendered INSIDE the collapsible tool-call block instead of the message body).
 *
 * Uses the real React reconciler (react-dom/server) to prove that:
 *   - <BodyArtifacts> renders cards / the ask_user form in the body, and
 *   - <ToolCallRenderer> filters those out (a card-only run shows no trace block).
 */

import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BodyArtifacts } from './body-artifacts';
import { ToolCallRenderer } from './index';
import { I18nProvider } from '../../lib/i18n';

function renderInLocale(element: ReturnType<typeof createElement>, locale: 'en' | 'zh'): string {
  return renderToStaticMarkup(createElement(I18nProvider, { initialLocale: locale, children: element }));
}

describe('retired tools in old transcripts', () => {
  it.each(['mission_dispatch', 'workflow_plan'])('renders a historical %s card call as a plain trace row', (name) => {
    const legacy = { name, input: {}, output: { type: name } };
    expect(renderToStaticMarkup(createElement(BodyArtifacts, { calls: [legacy], ctx: {} }))).toBe('');
    const trace = renderToStaticMarkup(createElement(ToolCallRenderer, { calls: [legacy], variant: 'full' as const }));
    expect(trace).toContain('Tool calls');
  });

  it('renders an eval_message call (tool removed in v1.4) as a plain trace row', () => {
    const legacy = { name: 'eval_message', input: {}, output: { score_final: 8.5, scores: {} } };
    expect(renderToStaticMarkup(createElement(BodyArtifacts, { calls: [legacy], ctx: {} }))).toBe('');
    const trace = renderToStaticMarkup(createElement(ToolCallRenderer, { calls: [legacy], variant: 'full' as const }));
    expect(trace).toContain('Tool calls');
  });
});

describe('tool trace summaries', () => {
  it('shows the current call only while it is running and clears the completed summary', () => {
    const running = renderInLocale(
      createElement(ToolCallRenderer, {
        calls: [{ name: 'external_search', input: { query: 'live-query' }, status: 'calling' }],
        variant: 'full' as const,
        defaultCollapsed: true,
      }),
      'en',
    );
    const completed = renderInLocale(
      createElement(ToolCallRenderer, {
        calls: [{ name: 'external_search', input: { query: 'finished-query' }, output: { resultCount: 1 } }],
        variant: 'full' as const,
        defaultCollapsed: true,
      }),
      'en',
    );

    expect(running).toContain('live-query');
    expect(completed).not.toContain('finished-query');
    expect(completed).toContain('Tool calls · 1');
  });
});

describe('generated image loading state', () => {
  it('renders an image-shaped skeleton while generate_image is running', () => {
    const html = renderInLocale(
      createElement(BodyArtifacts, {
        calls: [{ name: 'generate_image', input: { prompt: 'an ocean' }, status: 'calling' }],
        ctx: { streaming: true },
      }),
      'en',
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('Generating image…');
    expect(html).toContain('h-[260px]');
  });
});

describe('ask_user form placement', () => {
  it('BodyArtifacts renders the interactive form in the body', () => {
    const askCall = {
      name: 'ask_user',
      input: {},
      output: {
        type: 'ask_user',
        status: 'pending_user_input',
        title: 'A few questions',
        questions: [{ id: 'q1', label: 'Your name?', type: 'text' }],
      },
    };
    const html = renderToStaticMarkup(createElement(BodyArtifacts, { calls: [askCall], ctx: {} }));
    expect(html).toContain('A few questions');
    expect(html).toContain('Submit answers');
  });

  it('defers the ask_user form while the turn streams — appears only once committed', () => {
    const askCall = {
      name: 'ask_user',
      input: {},
      output: {
        type: 'ask_user',
        status: 'pending_user_input',
        title: 'A few questions',
        questions: [{ id: 'q1', label: 'Your name?', type: 'text' }],
      },
    };
    // Streaming overlay (ctx.streaming): the form is withheld — rendering it here would
    // let the user select options that get wiped on the overlay→committed remount.
    const streaming = renderToStaticMarkup(
      createElement(BodyArtifacts, { calls: [askCall], ctx: { streaming: true } }),
    );
    expect(streaming).not.toContain('A few questions');
    expect(streaming).not.toContain('Submit answers');

    // Committed bubble (no streaming flag): the interactive form renders.
    const committed = renderToStaticMarkup(createElement(BodyArtifacts, { calls: [askCall], ctx: {} }));
    expect(committed).toContain('A few questions');
    expect(committed).toContain('Submit answers');
  });

  it('still renders non-interactive artifacts (a generated image) while the turn streams', () => {
    const askCall = {
      name: 'ask_user',
      input: {},
      output: {
        type: 'ask_user',
        status: 'pending_user_input',
        title: 'A few questions',
        questions: [{ id: 'q1', label: 'Your name?', type: 'text' }],
      },
    };
    const imageCall = {
      name: 'generate_image',
      input: {},
      output: { success: true, url: '/api/upload/streamed-image.png', prompt: 'a plant' },
    };
    const html = renderToStaticMarkup(
      createElement(BodyArtifacts, { calls: [imageCall, askCall], ctx: { streaming: true } }),
    );
    expect(html).toContain('streamed-image.png'); // the image card streams in
    expect(html).not.toContain('A few questions'); // ask_user is deferred
  });
});

describe('file artifact placement', () => {
  const fileCall = {
    name: 'export_data',
    input: { source: { type: 'crm_customers' }, format: 'xlsx' },
    output: {
      type: 'file',
      file_id: 'file-1',
      name: 'crm-customers.xlsx',
      content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: 8192,
      row_count: 178,
      download_url: '/api/chat-files/file-1/content',
    },
  };

  it('renders a downloadable file card and removes the duplicate trace row', () => {
    const body = renderToStaticMarkup(createElement(BodyArtifacts, { calls: [fileCall], ctx: {} }));
    expect(body).toContain('crm-customers.xlsx');
    expect(body).toContain('Download');
    expect(body).toContain('<button');

    const trace = renderToStaticMarkup(
      createElement(ToolCallRenderer, { calls: [fileCall], variant: 'full' as const }),
    );
    expect(trace).toBe('');
  });
});
