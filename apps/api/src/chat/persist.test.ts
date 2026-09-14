import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEngineResult } from '@greenhouse/agent-core';
import { finalizeInterruptedChatContent, persistChatResult } from './persist.js';

const mocks = vi.hoisted(() => ({
  addMessage: vi.fn(),
  appendAssistantIfTail: vi.fn(),
  replaceLatestAssistant: vi.fn(),
  getSession: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('@greenhouse/db', () => ({
  getDb: () => ({
    sessions: {
      addMessage: mocks.addMessage,
      appendAssistantIfTail: mocks.appendAssistantIfTail,
      replaceLatestAssistant: mocks.replaceLatestAssistant,
      getById: mocks.getSession,
      update: mocks.updateSession,
    },
  }),
}));

function interruptedResult(text: string): ChatEngineResult {
  return {
    text,
    finishReason: 'error',
    usage: { inputTokens: 0, outputTokens: 0 },
    pipelineSteps: [],
    references: [],
    durationMs: 120_000,
    dsmlRecoveries: [],
  };
}

describe('interrupted chat persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.replaceLatestAssistant.mockResolvedValue({
      ok: true,
      message: { id: 'replacement' },
    });
    mocks.appendAssistantIfTail.mockResolvedValue({
      ok: true,
      message: { id: 'assistant' },
    });
  });

  it('removes an unfinished datatable and keeps the preceding safe text', () => {
    const content = 'Here are the customers:\n\n```datatable\n{"columns":[{"key":"name"';

    expect(finalizeInterruptedChatContent(content, 'Response interrupted.')).toBe(
      'Here are the customers:\n\n> Response interrupted.',
    );
  });

  it('keeps a completed datatable before appending the interruption notice', () => {
    const content = '```datatable\n{"columns":[{"key":"name","label":"Name"}],"rows":[{"name":"A"}]}\n```';

    expect(finalizeInterruptedChatContent(content, 'Response interrupted.')).toBe(
      `${content}\n\n> Response interrupted.`,
    );
  });

  it('persists a visible failure message even when the provider produced no safe text', async () => {
    await persistChatResult({
      sessionId: 'session-1',
      caller: 'chat',
      modelId: 'flash',
      engineResult: interruptedResult('```datatable\n{"columns":['),
      dsmlRecoveries: [],
      streamCompleted: false,
      interruptionReason: 'TimeoutError',
      interruptionNotice: '回答生成在完成前中断，未完成的内容已舍弃，请重试。',
    });

    expect(mocks.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 'session-1',
        role: 'assistant',
        content: '> 回答生成在完成前中断，未完成的内容已舍弃，请重试。',
      }),
    );
  });

  it('preserves the previous assistant when regeneration is interrupted', async () => {
    await persistChatResult({
      sessionId: 'session-1',
      caller: 'chat',
      modelId: 'flash',
      engineResult: interruptedResult('partial replacement'),
      dsmlRecoveries: [],
      streamCompleted: false,
      interruptionReason: 'TimeoutError',
      interruptionNotice: 'Response interrupted.',
      replaceAssistantMessageId: 'old-assistant',
    });

    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.replaceLatestAssistant).not.toHaveBeenCalled();
  });

  it('replaces the exact previous assistant after successful regeneration', async () => {
    const engineResult: ChatEngineResult = {
      ...interruptedResult('better answer'),
      finishReason: 'stop',
    };
    await persistChatResult({
      sessionId: 'session-1',
      caller: 'chat',
      modelId: 'flash',
      engineResult,
      dsmlRecoveries: [],
      streamCompleted: true,
      interruptionNotice: 'Response interrupted.',
      replaceAssistantMessageId: 'old-assistant',
    });

    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.replaceLatestAssistant).toHaveBeenCalledWith(
      'session-1',
      'old-assistant',
      expect.objectContaining({
        session_id: 'session-1',
        role: 'assistant',
        content: 'better answer',
      }),
      undefined,
    );
  });

  it('appends a normal reply only against the exact transcript tail', async () => {
    const engineResult: ChatEngineResult = {
      ...interruptedResult('fresh answer'),
      finishReason: 'stop',
    };
    await persistChatResult({
      sessionId: 'session-1',
      caller: 'chat',
      modelId: 'flash',
      engineResult,
      dsmlRecoveries: [],
      streamCompleted: true,
      interruptionNotice: 'Response interrupted.',
      expectedTail: { id: 'user-message', content: 'Current prompt' },
    });

    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.appendAssistantIfTail).toHaveBeenCalledWith(
      'session-1',
      { id: 'user-message', content: 'Current prompt' },
      expect.objectContaining({
        session_id: 'session-1',
        role: 'assistant',
        content: 'fresh answer',
        // Every persistence path must stamp the model, not just the
        // regeneration one. `MessageInput.model` is optional (user turns and
        // server-authored outcome messages have none), so dropping it here
        // type-checks fine and silently writes null — which is exactly what a
        // rebase onto the tail-CAS rewrite did once.
        model: 'flash',
      }),
      undefined,
    );
  });

  it('does not fall back to an unconditional append when the transcript changed', async () => {
    mocks.appendAssistantIfTail.mockResolvedValueOnce({
      ok: false,
      reason: 'transcript_changed',
    });

    await persistChatResult({
      sessionId: 'session-1',
      caller: 'chat',
      modelId: 'flash',
      engineResult: {
        ...interruptedResult('stale answer'),
        finishReason: 'stop',
      },
      dsmlRecoveries: [],
      streamCompleted: true,
      interruptionNotice: 'Response interrupted.',
      expectedTail: { id: 'user-message', content: 'Old prompt' },
    });

    expect(mocks.appendAssistantIfTail).toHaveBeenCalledOnce();
    expect(mocks.addMessage).not.toHaveBeenCalled();
  });
});
