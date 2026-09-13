/** @vitest-environment happy-dom */

import type { RuntimeDatasetCreateResult, RuntimeDatasetPreview } from '@greenhouse/types/eval';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';

const mocks = vi.hoisted(() => ({ preview: vi.fn(), create: vi.fn() }));
vi.mock('../../lib/api/runtime-dataset', () => ({
  previewRuntimeDataset: mocks.preview,
  createRuntimeDataset: mocks.create,
}));

import { TraceDatasetDialog } from './trace-dataset-dialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RUN = {
  id: 'rtr-ui-1',
  kind: 'mission',
  owner_user_id: 'owner',
  initiated_by_user_id: 'owner',
  session_id: 'session-ui-1',
  parent_run_id: null,
  root_run_id: 'rtr-ui-1',
  source_kind: 'agent_run',
  source_id: 'mission-ui-1',
  idempotency_key: null,
  status: 'failed',
  desired_state: 'run',
  wait_reason: null,
  priority: 0,
  not_before: null,
  deadline_at: null,
  lease_owner: null,
  lease_expires_at: null,
  heartbeat_at: null,
  attempt: 1,
  max_attempts: 3,
  input: { prompt: 'Exact source prompt', token: 'secret-value' },
  output: null,
  error_code: 'provider_error',
  error_message: 'Provider failed',
  started_at: '2026-08-12T00:00:00.000Z',
  ended_at: '2026-08-12T00:01:00.000Z',
  settled_at: '2026-08-12T00:01:00.000Z',
  created_at: '2026-08-12T00:00:00.000Z',
  updated_at: '2026-08-12T00:01:00.000Z',
  version: 2,
} as const;

const DRAFT = {
  category: 'runtime-mission',
  difficulty: 'medium',
  question: 'Editable question',
  ground_truth: 'Editable ground truth',
  expected_behavior: 'Complete without failure',
  tags: ['runtime-trace'],
  language: 'en',
  is_negative: true,
  enabled: true,
  notes: '',
} as const;

const PREVIEW: RuntimeDatasetPreview = {
  source: {
    runtime_run_id: RUN.id,
    runtime_kind: RUN.kind,
    runtime_status: RUN.status,
    source_kind: RUN.source_kind,
    source_id: RUN.source_id,
    session_id: RUN.session_id,
  },
  draft: { ...DRAFT, tags: [...DRAFT.tags] },
  evidence: {
    run: RUN,
    events: [],
    steps: [],
    tool_calls: [],
    artifacts: [],
    interrupts: [],
    eval_results: [],
    session_messages: [],
  },
  warnings: [
    {
      code: 'sensitive_content',
      message: 'Review sensitive content',
      paths: ['evidence.run.input.token'],
    },
  ],
};

const CREATED: RuntimeDatasetCreateResult = {
  created: true,
  source: PREVIEW.source,
  dataset: {
    id: 81,
    category: DRAFT.category,
    difficulty: DRAFT.difficulty,
    question: DRAFT.question,
    ground_truth: DRAFT.ground_truth,
    expected_behavior: DRAFT.expected_behavior,
    tags: JSON.stringify(DRAFT.tags),
    language: DRAFT.language,
    is_negative: 1,
    enabled: 1,
    created_by: 'admin',
    updated_by: 'admin',
    source: 'agent',
    source_session_id: RUN.session_id,
    status: 'active',
    notes: '[runtime-trace:v1] {}',
    archived_at: null,
    created_at: RUN.updated_at,
    updated_at: RUN.updated_at,
  },
};

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  document.body.replaceChildren();
  window.location.hash = '';
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe('TraceDatasetDialog', () => {
  it('only creates after explicit submit, blocks a double click, and deep-links to Eval Datasets', async () => {
    mocks.preview.mockResolvedValue(PREVIEW);
    let finishCreate: ((value: RuntimeDatasetCreateResult) => void) | undefined;
    mocks.create.mockImplementation(
      () => new Promise<RuntimeDatasetCreateResult>((resolve) => (finishCreate = resolve)),
    );
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        createElement(I18nProvider, {
          initialLocale: 'en',
          children: createElement(TraceDatasetDialog, { runId: RUN.id, open: true, onClose: vi.fn() }),
        }),
      );
    });

    expect(mocks.create).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('The complete evidence is unredacted');
    expect(document.body.textContent).toContain('evidence.run.input.token');
    expect(document.body.textContent).toContain('Complete source evidence (unredacted)');
    const question = Array.from(document.body.querySelectorAll('textarea')).find(
      (field) => field.value === DRAFT.question,
    );
    expect(question).toBeDefined();

    const createButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Create evaluation case',
    );
    expect(createButton).toBeDefined();
    await act(async () => {
      createButton?.click();
      createButton?.click();
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    const submitted = mocks.create.mock.calls[0] as [string, { idempotency_key: string; dataset: unknown }];
    expect(submitted[0]).toBe(RUN.id);
    expect(submitted[1].idempotency_key).toMatch(/^web:trace-dataset:rtr-ui-1:/);
    expect(submitted[1].dataset).toMatchObject({ question: DRAFT.question, ground_truth: DRAFT.ground_truth });

    await act(async () => finishCreate?.(CREATED));
    expect(window.location.hash).toBe('#/administration/eval/datasets');
  });
});
