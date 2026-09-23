/**
 * MissionDispatchCard rendering — the Launch confirm gate.
 *
 * Pins the 2026-08-03 UX fixes: the prompt goes through <Markdown compact>
 * (it is a Markdown brief, not preformatted text), long briefs collapse by
 * HEIGHT (character truncation used to cut fences/lists mid-syntax), the
 * model-supplied title heads the card, BodyArtifacts places the card below
 * the prose via position="below", a settled run collapses the card to a
 * one-line receipt that expands into the result, and the model is pickable
 * before Launch (defaulting to the conversation's current chat model).
 *
 * The real <Markdown> needs DOMParser for sanitizing, which the node test
 * environment does not have — the seam asserted here is "the raw prompt /
 * summary reaches <Markdown compact>", so the component is stubbed to echo
 * its props. Markdown→HTML behaviour belongs to markdown.tsx.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../markdown', () => ({
  Markdown: ({ content, compact }: { content: string; compact?: boolean }) =>
    createElement('div', { 'data-md': compact ? 'compact' : 'full' }, content),
}));

import {
  dispatchPromptMatchesRun,
  MissionDispatchCard,
  MissionDispatchCardView,
  resolveMissionModelDefault,
} from './mission-dispatch-card';
import type { CloudAgentRun } from '../../lib/api/cloud-agent';
import { BodyArtifacts } from '../tool-call/body-artifacts';
import { translate, type TranslationKey } from '../../lib/i18n';

const en = (key: TranslationKey) => translate('en', key);

const SHORT_PROMPT = '执行 **OCR** 提取任务：逐页转录，保留原文拼写。';
const LONG_PROMPT = ['# 任务', ...Array.from({ length: 12 }, (_, i) => `- 第 ${i + 1} 步：处理并核对`)].join('\n');

const artifact = (prompt: string) => ({ type: 'mission_dispatch' as const, title: 'ECT 说明书 OCR', prompt });

const settledRun = (over: Partial<CloudAgentRun> = {}): CloudAgentRun => ({
  id: 'car_test_1',
  status: 'completed',
  title: 'ECT 说明书 OCR',
  dispatch_id: 'cad_0000000000000001',
  original_prompt: SHORT_PROMPT,
  prompt: SHORT_PROMPT,
  input_manifest: '[]',
  model: 'deepseek-flash',
  fallback_model: 'pro',
  workspace_id: 1,
  session_id: 's1',
  max_wall_ms: 7_200_000,
  max_requests: 300,
  used_requests: 10,
  input_tokens: 1000,
  output_tokens: 100,
  result_summary: '转录完成：共 **24 页**，平均置信度 96.4%。',
  failure_code: null,
  error: null,
  journal_storage_key: null,
  queue_position: null,
  queue_reason: null,
  pending_approval_count: 0,
  queued_at: '2026-08-03T07:00:00Z',
  started_at: '2026-08-03T07:01:00Z',
  ended_at: '2026-08-03T07:20:00Z',
  settled_at: '2026-08-03T07:20:01Z',
  created_at: '2026-08-03T07:00:00Z',
  updated_at: '2026-08-03T07:20:00Z',
  ...over,
});

const viewDefaults = {
  sessionId: 's1',
  blockedBy: null,
  discovered: true,
  dismissed: false,
  launching: false,
  models: [] as Array<{ id: string; name: string }>,
  modelId: '',
  onModelChange: () => {},
  onLaunch: () => {},
  onDismiss: () => {},
  loadArtifacts: () => Promise.resolve([]),
};

describe('MissionDispatchCard (container, pre-launch)', () => {
  it('feeds the raw prompt into <Markdown compact> and shows the model-supplied title', () => {
    const html = renderToStaticMarkup(
      createElement(MissionDispatchCard, { artifact: artifact(SHORT_PROMPT), sessionId: 's1' }),
    );
    expect(html).toContain('ECT 说明书 OCR');
    expect(html).toContain('data-md="compact"');
    expect(html).toContain('**OCR**'); // the stub echoes — the raw brief reached Markdown intact
  });

  it('collapses a long brief by height with an expand toggle — never truncating the text', () => {
    const html = renderToStaticMarkup(
      createElement(MissionDispatchCard, { artifact: artifact(LONG_PROMPT), sessionId: 's1' }),
    );
    expect(html).toContain('max-h-44'); // height collapse
    expect(html).toContain('第 12 步'); // the tail of the brief is still in the DOM
    expect(html).toContain(en('common.expand'));
  });

  it('shows a short brief in full with no toggle', () => {
    const html = renderToStaticMarkup(
      createElement(MissionDispatchCard, { artifact: artifact(SHORT_PROMPT), sessionId: 's1' }),
    );
    expect(html).not.toContain('max-h-44');
    expect(html).not.toContain(en('common.expand'));
  });
});

describe('model choice before Launch', () => {
  it('resolveMissionModelDefault: dispatch pick > session model > deployment default', () => {
    const models = [
      { id: 'flash', name: 'Flash' },
      { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' },
    ];
    expect(resolveMissionModelDefault('pro', 'flash', models)).toBe('pro');
    expect(resolveMissionModelDefault(undefined, 'flash', models)).toBe('flash');
    expect(resolveMissionModelDefault(undefined, 'retired-model', models)).toBe(''); // not offered → default
    expect(resolveMissionModelDefault(undefined, null, models)).toBe('');
  });

  it('renders a model selector with the catalog + a deployment-default option', () => {
    const html = renderToStaticMarkup(
      createElement(MissionDispatchCardView, {
        ...viewDefaults,
        artifact: artifact(SHORT_PROMPT),
        run: null,
        models: [
          { id: 'flash', name: 'Flash' },
          { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' },
        ],
        modelId: 'flash',
      }),
    );
    expect(html).toContain('<select');
    expect(html).toContain('>Flash</option>');
    expect(html).toContain('>DeepSeek V4.1 Flash</option>');
    expect(html).toContain(en('cloudAgent.dispatchDefaultModel'));
    expect(html).toContain(en('cloudAgent.launch'));
  });

  it('hides the selector when the catalog has not loaded — Launch still works via the default', () => {
    const html = renderToStaticMarkup(
      createElement(MissionDispatchCardView, {
        ...viewDefaults,
        artifact: artifact(SHORT_PROMPT),
        run: null,
      }),
    );
    expect(html).not.toContain('<select');
    expect(html).toContain(en('cloudAgent.launch'));
  });
});

describe('run discovery after reload', () => {
  it('ignores the runner-only attachment annotation when matching the dispatch prompt', () => {
    expect(dispatchPromptMatchesRun(SHORT_PROMPT, SHORT_PROMPT)).toBe(true);
    expect(
      dispatchPromptMatchesRun(
        `${SHORT_PROMPT}\n\n[The user attached 1 file(s), available in ./inputs/: manual.pdf]`,
        SHORT_PROMPT,
      ),
    ).toBe(true);
    expect(dispatchPromptMatchesRun(`${SHORT_PROMPT} changed`, SHORT_PROMPT)).toBe(false);
  });
});

describe('settled card', () => {
  it('collapses to a one-line receipt: title + status, no prompt body', () => {
    const html = renderToStaticMarkup(
      createElement(MissionDispatchCardView, {
        ...viewDefaults,
        artifact: artifact(SHORT_PROMPT),
        run: settledRun(),
      }),
    );
    expect(html).toContain('ECT 说明书 OCR');
    expect(html).toContain('completed'); // status tag
    expect(html).not.toContain(en('cloudAgent.promptLabel')); // body hidden
    expect(html).not.toContain(en('cloudAgent.launch')); // nothing left to launch
  });

  it('expanding shows the prompt AND the result summary through <Markdown compact>', () => {
    const html = renderToStaticMarkup(
      createElement(MissionDispatchCardView, {
        ...viewDefaults,
        artifact: artifact(SHORT_PROMPT),
        run: settledRun(),
        defaultExpanded: true,
      }),
    );
    expect(html).toContain(en('cloudAgent.promptLabel'));
    expect(html).toContain(en('cloudAgent.resultLabel'));
    expect(html).toContain('共 **24 页**'); // raw summary reached the Markdown stub
  });

  it('a failed run surfaces its error in the expanded receipt', () => {
    const html = renderToStaticMarkup(
      createElement(MissionDispatchCardView, {
        ...viewDefaults,
        artifact: artifact(SHORT_PROMPT),
        run: settledRun({ status: 'failed', result_summary: null, error: 'wall-clock budget exceeded (120 min)' }),
        defaultExpanded: true,
      }),
    );
    expect(html).toContain('wall-clock budget exceeded');
    expect(html).not.toContain(en('cloudAgent.resultEmpty')); // the error already explains the absence
  });
});

describe('dispatch card placement via BodyArtifacts', () => {
  const dispatchCall = { name: 'mission_dispatch', input: {}, output: artifact(SHORT_PROMPT) };

  it('position="below" flips the outer margin so the card sits after the prose', () => {
    const above = renderToStaticMarkup(createElement(BodyArtifacts, { calls: [dispatchCall], ctx: {} }));
    expect(above).toContain('mb-3');
    const below = renderToStaticMarkup(
      createElement(BodyArtifacts, { calls: [dispatchCall], ctx: {}, position: 'below' as const }),
    );
    expect(below).toContain('mt-3');
    expect(below).not.toContain('mb-3');
  });
});
