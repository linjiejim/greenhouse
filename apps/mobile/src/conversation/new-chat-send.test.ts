import { describe, expect, it, vi } from 'vitest';
import type { ApiMiss, ApiResult } from '../api/client';
import type { ConversationDetail, SendMessageResult } from '../shared/contract';
import { newChatSendState, sendNewChat } from './new-chat-send';

const missing: ApiMiss = { ok: false, status: 404, code: 'not_found', message: 'Missing' };
const outage: ApiMiss = { ok: false, status: 503, code: 'unavailable', message: 'Try again' };
const chat = (id = 'chat-a', agent = 'agent-a'): ApiResult<ConversationDetail> => ({
  ok: true,
  data: { id, agent_id: agent } as ConversationDetail,
});
const sent: ApiResult<SendMessageResult> = {
  ok: true,
  data: { message: { id: 'message-a' }, queued: false } as SendMessageResult,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const scope = { generation: 0, mounted: true, focused: true, epoch: 0 };
  const state = newChatSendState();
  const create = vi.fn(async (_input: { kind: 'chat'; agent_id?: string }) => chat());
  const send = vi.fn(async (_id: string, _input: { content: string }) => sent);
  const read = vi.fn(async (_id: string) => chat());
  const remember = vi.fn();
  function run(agentId: string | null = 'agent-a', content = 'Analyze September orders') {
    const { generation, epoch } = scope;
    const current = () => scope.mounted && scope.generation === generation;
    const active = () => current() && scope.focused && scope.epoch === epoch;
    return sendNewChat(state, agentId, { content }, { current, active, create, send, read, remember });
  }
  return { scope, state, create, send, read, remember, run };
}

describe('the mobile first-chat send lifecycle', () => {
  it('claims before yielding so two same-tick sends create and send only once', async () => {
    const f = fixture();
    const creating = deferred<ApiResult<ConversationDetail>>();
    f.create.mockReturnValueOnce(creating.promise);
    const first = f.run();
    expect(f.state.sending).toBe(true);
    expect(await f.run()).toEqual({ status: 'busy' });
    expect(f.create).toHaveBeenCalledTimes(1);
    creating.resolve(chat());
    expect(await first).toEqual({ status: 'sent', conversationId: 'chat-a' });
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.state.sending).toBe(false);
  });

  it.each(['identity', 'unmount'] as const)(
    'drops a late create after %s changes, before any second request or cache write',
    async (change) => {
      const f = fixture();
      const creating = deferred<ApiResult<ConversationDetail>>();
      f.create.mockReturnValueOnce(creating.promise);
      const first = f.run();
      if (change === 'identity') f.scope.generation += 1;
      else f.scope.mounted = false;
      creating.resolve(chat());
      expect(await first).toEqual({ status: 'inactive' });
      expect(f.send).not.toHaveBeenCalled();
      expect(f.remember).not.toHaveBeenCalled();
      expect(f.state.chats.size).toBe(0);
      expect(f.state.sending).toBe(false);
    },
  );

  it('does not resume a create across focus leave-and-return; an explicit retry reuses its local chat', async () => {
    const f = fixture();
    const creating = deferred<ApiResult<ConversationDetail>>();
    f.create.mockReturnValueOnce(creating.promise);
    const first = f.run();
    f.scope.focused = false;
    f.scope.epoch += 1;
    f.scope.focused = true;
    f.scope.epoch += 1;
    creating.resolve(chat());
    expect(await first).toEqual({ status: 'inactive' });
    expect(f.remember).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.state.chats.get('agent-a')).toBe('chat-a');
    expect(await f.run()).toEqual({ status: 'sent', conversationId: 'chat-a' });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('keeps the created ID across repeated failures and keeps Agents separate', async () => {
    const f = fixture();
    f.send.mockResolvedValue(outage);
    f.create.mockResolvedValueOnce(chat()).mockResolvedValueOnce(chat('chat-b', 'agent-b'));
    await f.run('agent-a', 'A');
    await f.run('agent-a', 'A retry');
    await f.run('agent-b', 'B');
    await f.run('agent-a', 'A again');
    expect(f.create.mock.calls).toEqual([
      [{ kind: 'chat', agent_id: 'agent-a' }],
      [{ kind: 'chat', agent_id: 'agent-b' }],
    ]);
    expect(f.send.mock.calls.map(([id]) => id)).toEqual(['chat-a', 'chat-a', 'chat-b', 'chat-a']);
    expect(f.read).not.toHaveBeenCalled();
  });

  it('passes a missing-directory explicit Agent ID to the API without falling back to main', async () => {
    const f = fixture();
    f.create.mockResolvedValueOnce(missing);
    expect(await f.run('explicit-agent')).toEqual({ status: 'failed', stage: 'create', error: missing });
    expect(f.create).toHaveBeenCalledWith({ kind: 'chat', agent_id: 'explicit-agent' });
    expect(f.send).not.toHaveBeenCalled();
    expect(f.state.chats.size).toBe(0);
  });

  it('reuses a default-main chat when the directory later supplies its actual Agent ID', async () => {
    const f = fixture();
    f.create.mockResolvedValueOnce(chat('main-chat', 'main-agent'));
    f.send.mockResolvedValueOnce(outage);
    await f.run(null);
    expect(f.state.chats.get('main')).toBe('main-chat');
    expect(f.state.chats.get('main-agent')).toBe('main-chat');
    expect(await f.run('main-agent')).toEqual({ status: 'sent', conversationId: 'main-chat' });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls.map(([id]) => id)).toEqual(['main-chat', 'main-chat']);
  });

  it('consumes a known successful send after blur without authorizing navigation or another send', async () => {
    const f = fixture();
    f.state.chats.set('agent-a', 'chat-a');
    const sending = deferred<ApiResult<SendMessageResult>>();
    f.send.mockReturnValueOnce(sending.promise);
    const first = f.run();
    f.scope.focused = false;
    f.scope.epoch += 1;
    sending.resolve(sent);
    expect(await first).toEqual({ status: 'sent', conversationId: 'chat-a' });
    expect(f.remember).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.state.chats.size).toBe(0);
    expect(await f.run()).toEqual({ status: 'inactive' });
    expect(f.send).toHaveBeenCalledTimes(1);
    f.scope.focused = true;
    f.scope.epoch += 1;
    f.create.mockResolvedValueOnce(chat('chat-b'));
    expect(await f.run('agent-a', 'A new task after returning')).toEqual({ status: 'sent', conversationId: 'chat-b' });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls.map(([id]) => id)).toEqual(['chat-a', 'chat-b']);
  });

  it('drops a late sent result after an identity switch, including switch away and back', async () => {
    const f = fixture();
    f.state.chats.set('agent-a', 'chat-a');
    const sending = deferred<ApiResult<SendMessageResult>>();
    f.send.mockReturnValueOnce(sending.promise);
    const first = f.run();
    f.scope.generation += 2;
    sending.resolve(sent);
    expect(await first).toEqual({ status: 'inactive' });
    expect(f.read).not.toHaveBeenCalled();
    expect(f.remember).not.toHaveBeenCalled();
  });

  it.each([chat(), outage])(
    'retains a chat on message not_found unless its own read confirms it is gone (%j)',
    async (result) => {
      const f = fixture();
      f.state.chats.set('agent-a', 'chat-a');
      f.send.mockResolvedValueOnce(missing);
      f.read.mockResolvedValueOnce(result);
      expect(await f.run()).toEqual({ status: 'failed', stage: 'send', error: missing });
      expect(f.state.chats.get('agent-a')).toBe('chat-a');
      await f.run();
      expect(f.create).not.toHaveBeenCalled();
      expect(f.send.mock.calls.map(([id]) => id)).toEqual(['chat-a', 'chat-a']);
    },
  );

  it('clears all aliases only after confirmed deletion, and waits for the next explicit send to recreate', async () => {
    const f = fixture();
    f.state.chats.set('main', 'gone');
    f.state.chats.set('main-agent-id', 'gone');
    f.state.chats.set('other-agent', 'other-chat');
    f.send.mockResolvedValueOnce(missing);
    f.read.mockResolvedValueOnce(missing);
    expect(await f.run(null)).toEqual({ status: 'failed', stage: 'send', error: missing });
    expect([...f.state.chats]).toEqual([['other-agent', 'other-chat']]);
    expect(f.create).not.toHaveBeenCalled();
    await f.run(null);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.create).toHaveBeenCalledWith({ kind: 'chat' });
  });

  it('does not issue a missing-chat read after blur, or clear IDs from a stale read after identity changes', async () => {
    const f = fixture();
    f.state.chats.set('agent-a', 'chat-a');
    const sending = deferred<ApiResult<SendMessageResult>>();
    f.send.mockReturnValueOnce(sending.promise);
    const first = f.run();
    f.scope.epoch += 1;
    sending.resolve(missing);
    await first;
    expect(f.read).not.toHaveBeenCalled();
    f.send.mockResolvedValueOnce(missing);
    const reading = deferred<ApiResult<ConversationDetail>>();
    f.read.mockReturnValueOnce(reading.promise);
    const second = f.run();
    await Promise.resolve();
    expect(f.read).toHaveBeenCalledTimes(1);
    f.scope.generation += 1;
    reading.resolve(missing);
    expect(await second).toEqual({ status: 'inactive' });
    expect(f.state.chats.get('agent-a')).toBe('chat-a');
  });
});
