/**
 * Render-level test for the trace-vs-artifact split. Uses the real React
 * reconciler (react-dom/server) to prove that:
 *   - <BodyArtifacts> renders interactive artifacts (ask_user form, spawn card) in
 *     the message body, and
 *   - <ToolCallRenderer> filters those out (an artifact-only run shows no trace block).
 */

import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BodyArtifacts } from './body-artifacts';
import { ToolCallRenderer } from './index';

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
    expect(html).toContain('Submit Answers');
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
    expect(streaming).not.toContain('Submit Answers');

    // Committed bubble (no streaming flag): the interactive form renders.
    const committed = renderToStaticMarkup(createElement(BodyArtifacts, { calls: [askCall], ctx: {} }));
    expect(committed).toContain('A few questions');
    expect(committed).toContain('Submit Answers');
  });

  it('still renders non-interactive artifacts (generated image) while the turn streams', () => {
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
      output: { success: true, url: 'http://x/streamed.png', prompt: 'a sprout' },
    };
    const html = renderToStaticMarkup(
      createElement(BodyArtifacts, { calls: [imageCall, askCall], ctx: { streaming: true } }),
    );
    expect(html).toContain('streamed.png'); // image card streams in
    expect(html).not.toContain('A few questions'); // ask_user is deferred
  });
});

describe('spawn_session card placement', () => {
  const spawnCall = {
    name: 'spawn_session',
    input: {},
    output: { status: 'completed', child_session_id: 'child-123', title: '[spawn-session] research X', depth: 1 },
  };

  it('BodyArtifacts renders the spawned sub-session card with its title in the body', () => {
    const html = renderToStaticMarkup(createElement(BodyArtifacts, { calls: [spawnCall], ctx: {} }));
    expect(html).toContain('[spawn-session] research X'); // the child title (data)
    expect(html).toContain('lucide-git-branch'); // the card's icon
  });

  it('renders an Open button only when an onOpenSession handler is provided', () => {
    // (i18n labels resolve to keys in SSR without a provider, so assert on structure.)
    const withHandler = renderToStaticMarkup(
      createElement(BodyArtifacts, { calls: [spawnCall], ctx: { onOpenSession: () => {} } }),
    );
    expect(withHandler).toContain('<button');
    const without = renderToStaticMarkup(createElement(BodyArtifacts, { calls: [spawnCall], ctx: {} }));
    expect(without).not.toContain('<button');
  });

  it('ToolCallRenderer keeps the spawn card out of the trace block', () => {
    const html = renderToStaticMarkup(
      createElement(ToolCallRenderer, { calls: [spawnCall], variant: 'full' as const }),
    );
    expect(html).toBe('');
  });

  it('an errored spawn (no child created) falls back to the trace block (no card)', () => {
    const errored = { name: 'spawn_session', input: {}, output: { error: 'Max spawn depth reached' } };
    const html = renderToStaticMarkup(createElement(BodyArtifacts, { calls: [errored], ctx: {} }));
    expect(html).toBe('');
  });

  it('renders an in-flight progress card (title from input + elapsed timer) before the child returns', () => {
    const inflight = {
      name: 'spawn_session',
      input: { title: 'AeroGarden 深度调研', prompt: 'research it' },
      output: undefined,
      status: 'calling' as const,
    };
    const html = renderToStaticMarkup(createElement(BodyArtifacts, { calls: [inflight], ctx: { streaming: true } }));
    expect(html).toContain('AeroGarden 深度调研'); // title pulled from the streaming input
    expect(html).toContain('0:00'); // the elapsed-time counter (SSR initial value)
    expect(html).not.toContain('<button'); // no child id yet → no Open button
  });
});
