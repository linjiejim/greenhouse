import { describe, expect, it } from 'vitest';
import {
  availableRuntimeUserActions,
  canTransitionRuntimeArtifact,
  canTransitionRuntimeInterrupt,
  canTransitionRuntimeOutbox,
  canTransitionRuntimeRun,
  canTransitionRuntimeStep,
  canTransitionRuntimeToolCall,
  isRuntimeInterruptCommandLegal,
  isRuntimeRunCommandLegal,
  isRuntimeRunTerminal,
  projectRuntimeForUser,
  type RuntimeEvent,
  type RuntimePayload,
} from './runtime.js';

describe('Runtime state transitions', () => {
  it('allows claim, wait, resume and terminal run transitions', () => {
    expect(canTransitionRuntimeRun('queued', 'claimed')).toBe(true);
    expect(canTransitionRuntimeRun('running', 'waiting')).toBe(true);
    expect(canTransitionRuntimeRun('waiting', 'running')).toBe(true);
    expect(canTransitionRuntimeRun('running', 'succeeded')).toBe(true);
    expect(isRuntimeRunTerminal('succeeded')).toBe(true);
  });

  it('supports stale-lease recovery and explicit retry without reopening immutable terminals', () => {
    expect(canTransitionRuntimeRun('claimed', 'queued')).toBe(true);
    expect(canTransitionRuntimeRun('failed', 'queued')).toBe(true);
    expect(canTransitionRuntimeRun('interrupted', 'queued')).toBe(true);
    expect(canTransitionRuntimeRun('succeeded', 'running')).toBe(false);
    expect(canTransitionRuntimeRun('canceled', 'queued')).toBe(false);

    expect(canTransitionRuntimeStep('claimed', 'queued')).toBe(true);
    expect(canTransitionRuntimeStep('failed', 'queued')).toBe(true);
    expect(canTransitionRuntimeStep('skipped', 'running')).toBe(false);
  });

  it('stops uncertain writes until a human establishes the external outcome', () => {
    expect(canTransitionRuntimeToolCall('running', 'uncertain')).toBe(true);
    expect(canTransitionRuntimeToolCall('uncertain', 'succeeded')).toBe(true);
    expect(canTransitionRuntimeToolCall('uncertain', 'running')).toBe(false);
    expect(canTransitionRuntimeToolCall('failed', 'running')).toBe(false);
  });

  it('keeps artifact, interrupt and outbox lifecycles narrow', () => {
    expect(canTransitionRuntimeArtifact('pending', 'available')).toBe(true);
    expect(canTransitionRuntimeArtifact('failed', 'available')).toBe(false);
    expect(canTransitionRuntimeInterrupt('pending', 'resolved')).toBe(true);
    expect(canTransitionRuntimeInterrupt('resolved', 'pending')).toBe(false);
    expect(canTransitionRuntimeOutbox('claimed', 'pending')).toBe(true);
    expect(canTransitionRuntimeOutbox('failed', 'dead_letter')).toBe(true);
    expect(canTransitionRuntimeOutbox('delivered', 'pending')).toBe(false);
  });
});

describe('Runtime commands', () => {
  it('derives legal commands from lifecycle and desired state', () => {
    expect(isRuntimeRunCommandLegal('queued', 'start')).toBe(true);
    expect(isRuntimeRunCommandLegal('running', 'pause')).toBe(true);
    expect(isRuntimeRunCommandLegal('paused', 'resume')).toBe(true);
    expect(isRuntimeRunCommandLegal('failed', 'retry')).toBe(true);
    expect(isRuntimeRunCommandLegal('running', 'retry')).toBe(false);
    expect(isRuntimeRunCommandLegal('running', 'cancel', 'cancel')).toBe(false);
  });

  it('only consumes a pending interrupt once', () => {
    expect(isRuntimeInterruptCommandLegal('pending', 'resolve')).toBe(true);
    expect(isRuntimeInterruptCommandLegal('pending', 'reject')).toBe(true);
    expect(isRuntimeInterruptCommandLegal('resolved', 'resolve')).toBe(false);
    expect(isRuntimeInterruptCommandLegal('rejected', 'cancel')).toBe(false);
  });
});

describe('Runtime user projection', () => {
  it.each([
    ['queued', 'queued'],
    ['claimed', 'preparing'],
    ['running', 'running'],
    ['waiting', 'paused'],
    ['paused', 'paused'],
    ['succeeded', 'completed'],
    ['failed', 'failed'],
    ['interrupted', 'failed'],
    ['canceled', 'canceled'],
  ] as const)('projects %s to lifecycle %s', (status, lifecycle) => {
    expect(projectRuntimeForUser({ status })).toEqual({ lifecycle, attention: 'none', transport: 'live' });
  });

  it('keeps lifecycle, attention and transport orthogonal', () => {
    expect(
      projectRuntimeForUser({
        status: 'running',
        transport: 'reconnecting',
        interrupts: [
          { kind: 'outcome_unknown', status: 'pending' },
          { kind: 'ask_user', status: 'resolved' },
          { kind: 'mutation_approval', status: 'pending' },
        ],
      }),
    ).toEqual({ lifecycle: 'running', attention: 'approval', transport: 'reconnecting' });
  });

  it('never invents an action the domain driver did not declare', () => {
    expect(
      availableRuntimeUserActions({
        status: 'running',
        supported_actions: ['cancel'],
      }),
    ).toEqual(['cancel']);

    expect(
      availableRuntimeUserActions({
        status: 'waiting',
        interrupts: [{ kind: 'workflow_gate', status: 'pending' }],
        supported_actions: ['pause', 'approve', 'reject', 'retry'],
      }),
    ).toEqual(['approve', 'reject']);
  });

  it('keeps the driver declaration order and removes duplicate buttons', () => {
    expect(
      availableRuntimeUserActions({
        status: 'failed',
        supported_actions: ['retry', 'retry', 'cancel'],
      }),
    ).toEqual(['retry']);
  });
});

describe('Runtime payload retention contract', () => {
  it('represents a full decoded payload without the legacy 16 KB event ceiling', () => {
    const payload: RuntimePayload = {
      input: { nested: ['exact', 42, true, null] },
      content: 'x'.repeat(32 * 1024),
    };
    const event: RuntimeEvent = {
      id: 'evt_1',
      run_id: 'run_1',
      step_id: null,
      seq: 1,
      type: 'mission.workspace_checkpointed',
      payload,
      actor_user_id: null,
      idempotency_key: 'checkpoint:1',
      created_at: '2026-08-12T00:00:00.000Z',
    };

    expect(event.payload).toBe(payload);
    expect((event.payload as { content: string }).content).toHaveLength(32 * 1024);
  });
});
