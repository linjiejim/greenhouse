/**
 * Render-level regression test for the reported issue: the "Evaluation Result"
 * card rendered INSIDE the collapsible tool-call block instead of the message body.
 *
 * Uses the real React reconciler (react-dom/server) to prove that after the
 * trace-vs-artifact split:
 *   - <BodyArtifacts> renders the eval card / ask_user form in the body, and
 *   - <ToolCallRenderer> filters those out (an eval-only run shows no trace block).
 */

import { afterEach, describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BodyArtifacts } from './body-artifacts';
import { ToolCallRenderer } from './index';
import { I18nProvider } from '../../lib/i18n';
import { useAuthStore } from '../../stores';

afterEach(() => useAuthStore.getState().setCurrentUser(null));

function renderInLocale(element: ReturnType<typeof createElement>, locale: 'en' | 'zh'): string {
  return renderToStaticMarkup(createElement(I18nProvider, { initialLocale: locale, children: element }));
}

const evalCall = {
  name: 'eval_message',
  input: {},
  output: {
    score_final: 8.5,
    scores: { accuracy: { score: 8, reason: 'ok' } },
    discrepancies: [],
  },
};

const workflowCall = {
  name: 'workflow_plan',
  input: {},
  output: {
    type: 'workflow_plan',
    workflow_id: 1,
    version: 1,
    name: 'Private rollout workflow',
    task_input: 'Test the workflow',
    graph: { nodes: [], deliverable_node: '' },
    budget: { max_nodes: 8, concurrency: 2, max_tokens: 10_000 },
  },
};

describe('workflow super-only visibility', () => {
  it('hides historical workflow cards when there is no eligible super user', () => {
    useAuthStore.getState().setCurrentUser({
      id: 'team-1',
      email: 'team@example.com',
      nickname: 'Team',
      role: 'team',
    });
    expect(renderToStaticMarkup(createElement(BodyArtifacts, { calls: [workflowCall], ctx: {} }))).toBe('');
  });
});

describe('eval result placement', () => {
  it('BodyArtifacts renders the Evaluation Result card in the body', () => {
    const html = renderToStaticMarkup(createElement(BodyArtifacts, { calls: [evalCall], ctx: {} }));
    expect(html).toContain('Evaluation Result');
  });

  it('ToolCallRenderer no longer renders the eval card — an eval-only run shows no trace block', () => {
    const html = renderToStaticMarkup(createElement(ToolCallRenderer, { calls: [evalCall], variant: 'full' as const }));
    expect(html).toBe('');
  });

  it('a mixed run keeps process tools in the trace block and the eval card out of it', () => {
    const search = { name: 'knowledge_query', input: { query: 'x' }, output: { found: 2 } };
    const html = renderToStaticMarkup(
      createElement(ToolCallRenderer, { calls: [search, evalCall], variant: 'full' as const }),
    );
    expect(html).toContain('Tool calls'); // the search row keeps the trace block alive
    expect(html).not.toContain('Evaluation Result'); // the eval card is not here
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

const evalV2Fail = {
  name: 'eval_message',
  input: {},
  output: {
    verdict: 'fail',
    verdict_reason: '安全高风险，一票否决',
    score_final: 3.8,
    classification: {
      reply_class: 'kb_plus_model',
      intent_summary: 'Max 水泵异响',
      q_type_l1: 'device',
      q_type_l2: '故障自查',
    },
    dimensions: {
      kb_consistency: { score: 3, reason: '新增/漏写' },
      citation_correctness: { score: 9, reason: '型号匹配' },
      boundary_control: { score: 5, reason: '越界' },
      safety: { score: 0, reason: '鼓励拆机' },
    },
    consistency_detail: {
      consistent: [],
      added: ['拆开泵体清理'],
      rewritten: [],
      omitted: ['联系客服'],
      unsupported: [],
    },
    citation_issues: [],
    suggestions: ['删除拆机段'],
    references_checked: [
      { slug: 'max-pump-noise', title: 'Max 水泵噪音排查', category: 'device', source_id: 'src_123', relevant: true },
      { slug: 'missing-doc', title: '未命中文档', relevant: false },
    ],
    steps: [],
  },
};

const evalV2Pending = {
  name: 'eval_message',
  input: {},
  output: {
    verdict: 'pending',
    score_final: null,
    dimensions: { kb_consistency: { score: 5, reason: '' }, safety: { score: 10, reason: '' } },
    consistency_detail: {},
    suggestions: [],
    steps: [],
  },
};

describe('eval result v2 (verdict + 4 dims)', () => {
  it('renders the verdict badge, dimensions, consistency breakdown and suggestions — not the legacy card', () => {
    const html = renderInLocale(createElement(BodyArtifacts, { calls: [evalV2Fail], ctx: {} }), 'zh');
    expect(html).toContain('问答评测'); // v2 header
    expect(html).toContain('不通过'); // verdict badge
    expect(html).toContain('安全性'); // safety dimension
    expect(html).toContain('＋新增'); // consistency breakdown
    expect(html).toContain('修改建议'); // suggestions
    expect(html).toContain('参考原文'); // 查看原文 section header
    expect(html).toContain('Max 水泵噪音排查'); // a clickable reference chip → opens the source modal
    expect(html).not.toContain('line-clamp'); // dimension reasons are shown in full, not truncated
    expect(html).not.toContain('Evaluation Result'); // legacy layout is NOT used
  });

  it('renders the 暂定 verdict for pending evals (KB insufficient)', () => {
    const html = renderInLocale(createElement(BodyArtifacts, { calls: [evalV2Pending], ctx: {} }), 'zh');
    expect(html).toContain('暂定');
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

  it('still renders non-interactive artifacts (eval) while the turn streams', () => {
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
    const html = renderToStaticMarkup(
      createElement(BodyArtifacts, { calls: [evalCall, askCall], ctx: { streaming: true } }),
    );
    expect(html).toContain('Evaluation Result'); // eval card streams in
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
