/** @vitest-environment happy-dom */

/**
 * "New chat" with Agents on (spec 20261011-agent-first-class §5a): the first send creates a
 * separate Agent chat with the picked Agent and model, uploads the files against it, hands the
 * message to the chat it opens and switches there — or says which step failed, leaving nothing
 * behind.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotsApiError } from '../../lib/api/bots';
import { useBotsStore } from '../bots/bots-store';
import { takeFirstSend } from '../bots/first-send';
import { AgentChatStartError, startAgentChat } from './start-agent-chat';

const api = vi.hoisted(() => ({ createTaskChat: vi.fn(), updateSession: vi.fn() }));
vi.mock('../../lib/api/bots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/bots')>()),
  createTaskChat: api.createTaskChat,
}));
vi.mock('../../lib/api/sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/sessions')>()),
  updateSession: api.updateSession,
}));

beforeEach(() => {
  window.location.hash = '#/chat';
  api.createTaskChat.mockReset().mockResolvedValue({ conversation: { session_id: 'chat-1' } });
  api.updateSession.mockReset().mockResolvedValue({});
});
afterEach(() => {
  takeFirstSend('chat-1');
  useBotsStore.setState({ ...useBotsStore.getInitialState() });
});

describe('startAgentChat', () => {
  it('creates the chat with the picked Agent and model, queues the message there and opens it', async () => {
    const images = [{ id: 'img-1', url: '/api/upload/img-1' }];
    const id = await startAgentChat({
      message: 'Compare the vendors',
      draft: 'Compare the vendors',
      images,
      botId: 'bot_sage',
      modelId: 'pro',
    });

    expect(id).toBe('chat-1');
    expect(api.createTaskChat).toHaveBeenCalledWith({ botId: 'bot_sage', modelId: 'pro' });
    expect(window.location.hash).toBe('#/bots?c=chat-1');
    expect(useBotsStore.getState().knownSessionIds.has('chat-1')).toBe(true);
    // The chat's own view sends it (once).
    expect(takeFirstSend('chat-1')).toEqual({ content: 'Compare the vendors', images, draft: 'Compare the vendors' });
    expect(takeFirstSend('chat-1')).toBeNull();
  });

  it('leaves the Agent and model to their defaults when none was picked', async () => {
    await startAgentChat({ message: 'hi', draft: 'hi', images: [], modelId: null });
    expect(api.createTaskChat).toHaveBeenCalledWith({});
  });

  it('uploads the files against the new chat and sends them as the attachments fence', async () => {
    const upload = vi.fn(async () => [{ id: 'f1', name: 'notes.pdf', size: 12 }]);
    await startAgentChat({ message: 'Summarize', draft: 'Summarize', images: [], uploadAttachments: upload });

    expect(upload).toHaveBeenCalledWith('chat-1');
    const first = takeFirstSend('chat-1');
    expect(first?.content).toBe('Summarize\n\n```attachments\n[{"id":"f1","name":"notes.pdf","size_bytes":12}]\n```');
    // The draft given back on a failed send is the text as typed, never the fence.
    expect(first?.draft).toBe('Summarize');
  });

  it('removes the empty chat and stays put when a file does not upload', async () => {
    const error = await startAgentChat({
      message: 'Summarize',
      draft: 'Summarize',
      images: [],
      uploadAttachments: async () => null,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AgentChatStartError);
    expect((error as AgentChatStartError).stage).toBe('attachments');
    expect(api.updateSession).toHaveBeenCalledWith('chat-1', { status: 'deleted' });
    expect(window.location.hash).toBe('#/chat');
    expect(takeFirstSend('chat-1')).toBeNull();
  });

  it('reports a refused create without opening anything', async () => {
    api.createTaskChat.mockRejectedValue(new BotsApiError('Bots are not enabled', 403));
    const error = await startAgentChat({ message: 'hi', draft: 'hi', images: [] }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AgentChatStartError);
    expect((error as AgentChatStartError).stage).toBe('create');
    expect(window.location.hash).toBe('#/chat');
  });
});
