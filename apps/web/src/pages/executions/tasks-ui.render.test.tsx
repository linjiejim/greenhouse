import type { RuntimeInterrupt, RuntimeRun, RuntimeToolCall } from '@greenhouse/types/runtime';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { RuntimeInterruptsSection } from './interrupts-section';
import { RuntimeToolCallsSection } from './runtime-detail-sections';
import { TaskRunList } from './task-list';
import { ApprovalInbox } from './approval-inbox';

function render(node: ReactNode) {
  return renderToStaticMarkup(createElement(I18nProvider, { initialLocale: 'en', children: node }));
}

const RUN: RuntimeRun = {
  id: 'run-1',
  kind: 'mission',
  owner_user_id: 'user-1',
  initiated_by_user_id: 'user-1',
  session_id: null,
  parent_run_id: null,
  root_run_id: 'run-1',
  source_kind: 'agent_run',
  source_id: 'source-1',
  idempotency_key: null,
  status: 'running',
  desired_state: 'run',
  wait_reason: null,
  priority: 0,
  not_before: null,
  deadline_at: null,
  lease_owner: 'worker-1',
  lease_expires_at: '2999-01-01T00:00:00.000Z',
  heartbeat_at: '2026-08-12T00:00:00.000Z',
  attempt: 1,
  max_attempts: 3,
  input: { title: 'Market review', prompt: 'Compare every current product with complete sources.' },
  output: null,
  error_code: null,
  error_message: null,
  started_at: '2026-08-12T00:00:00.000Z',
  ended_at: null,
  settled_at: null,
  created_at: '2026-08-12T00:00:00.000Z',
  updated_at: '2026-08-12T00:00:00.000Z',
  version: 1,
};

const INTERRUPT: RuntimeInterrupt = {
  id: 'interrupt-1',
  run_id: RUN.id,
  step_id: null,
  tool_call_id: null,
  kind: 'mutation_approval',
  status: 'pending',
  payload: { action: 'send', recipient: 'ceo@example.com', exact_subject: 'Q3 plan' },
  canonical_input_hash: 'abc123',
  risk_level: 'r2',
  assignee_user_id: 'user-1',
  expires_at: null,
  decision: null,
  decided_by_user_id: null,
  decided_at: null,
  created_at: '2026-08-12T00:00:00.000Z',
  updated_at: '2026-08-12T00:00:00.000Z',
  version: 1,
};

describe('Execution Center UI', () => {
  it('renders a canonical deep link plus independent execution, interaction, and connection axes', () => {
    const html = render(<TaskRunList runs={[RUN]} interrupts={[INTERRUPT]} />);
    expect(html).toContain('href="#/executions/mission/run-1"');
    expect(html).toContain('Market review');
    expect(html).toContain('title="Execution: Running"');
    expect(html).toContain('title="Interaction: Approval needed"');
    expect(html).toContain('title="Connection: Live"');
  });

  it('shows approval actions only when the server capability list includes them', () => {
    const withoutActions = render(
      <RuntimeInterruptsSection interrupts={[INTERRUPT]} actions={[]} busyId={null} onDecision={vi.fn()} />,
    );
    expect(withoutActions).not.toContain('>Approve<');
    expect(withoutActions).not.toContain('>Reject<');

    const withActions = render(
      <RuntimeInterruptsSection
        interrupts={[INTERRUPT]}
        actions={['approve', 'reject']}
        busyId={null}
        onDecision={vi.fn()}
      />,
    );
    expect(withActions).toContain('>Approve<');
    expect(withActions).toContain('>Reject<');
    expect(withActions).toContain('ceo@example.com');
    expect(withActions).toContain('abc123');
  });

  it('keeps attention cards focused on the execution title instead of raw payload content', () => {
    const html = render(<ApprovalInbox items={[{ run: RUN, interrupt: INTERRUPT }]} />);
    expect(html).toContain('Market review');
    expect(html).toContain('Change approval');
    expect(html).not.toContain('ceo@example.com');
    expect(html).not.toContain('Q3 plan');
  });

  it('renders complete tool input and output in collapsible technical details', () => {
    const call: RuntimeToolCall = {
      id: 'tool-1',
      run_id: RUN.id,
      step_id: null,
      tool_name: 'crm_mutation',
      status: 'succeeded',
      input: { rows: [{ email: 'customer@example.com', fields: { note: 'Complete unabridged input' } }] },
      output: { ids: ['company-1'], response: 'Complete unabridged output' },
      canonical_input_hash: 'tool-hash',
      risk_level: 'r1',
      idempotency_key: 'idem-1',
      interrupt_id: null,
      platform_audit_event_id: 'audit-1',
      error_code: null,
      error_message: null,
      started_at: '2026-08-12T00:00:00.000Z',
      ended_at: '2026-08-12T00:00:01.000Z',
      created_at: '2026-08-12T00:00:00.000Z',
      updated_at: '2026-08-12T00:00:01.000Z',
      version: 1,
    };
    const html = render(<RuntimeToolCallsSection calls={[call]} />);
    expect(html).toContain('Complete tool input');
    expect(html).toContain('customer@example.com');
    expect(html).toContain('Complete unabridged input');
    expect(html).toContain('Complete unabridged output');
  });
});
