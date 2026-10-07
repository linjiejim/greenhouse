/** @vitest-environment happy-dom */

import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotView } from '@greenhouse/types/bots';
import { I18nProvider } from '../../lib/i18n';
import { ToastContainer } from '../ui';
import { BotsComposer, type BotsComposerHandle } from './bots-composer';
import type { StopPhase } from './use-bot-conversation';

const uploads = vi.hoisted(() => ({ uploadChatFile: vi.fn(), uploadImage: vi.fn() }));
vi.mock('../../lib/api/chat-files', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/chat-files')>()),
  uploadChatFile: uploads.uploadChatFile,
}));
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  uploadImage: uploads.uploadImage,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPROUTY: BotView = {
  id: 'bot_sprouty',
  name: 'Sprouty',
  role: 'Chief of staff',
  instructions: '',
  avatar: { color: 'forest' },
  model_id: null,
  template_key: null,
  status: 'active',
  dm_session_id: 'dm-1',
  last_active_at: null,
  created_at: '2026-10-05T00:00:00.000Z',
};

let root: ReturnType<typeof createRoot> | null = null;
const onSend = vi.fn<(text: string, images: Array<{ id: string; url: string }>, mentions: string[]) => Promise<void>>();
const onInvite = vi.fn();
const handle = { current: null as BotsComposerHandle | null };

const onStop = vi.fn();

function Harness({ busy = false, stopPhase = null }: { busy?: boolean; stopPhase?: StopPhase }) {
  const [input, setInput] = useState('');
  const inputRef = { current: null as HTMLTextAreaElement | null };
  return createElement(BotsComposer, {
    ref: handle,
    sessionId: 'dm-1',
    members: [SPROUTY],
    placeholder: 'Message Sprouty…',
    busy,
    stopPhase,
    input,
    setInput,
    onSend,
    onStop,
    onInvite,
    canInvite: true,
    inputRef,
  });
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(harness: { busy?: boolean; stopPhase?: StopPhase } = {}) {
  if (!root) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => {
    root?.render(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: [createElement(Harness, { key: 'c', ...harness }), createElement(ToastContainer, { key: 't' })],
      }),
    );
  });
  await flush();
}

function textarea(): HTMLTextAreaElement {
  const el = document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]');
  if (!el) throw new Error('no composer');
  return el;
}

/** Type the whole value with the caret at its end, the way the trigger hook reads it. */
async function type(value: string) {
  const el = textarea();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.setSelectionRange(value.length, value.length);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

/** A key press as the browser delivers it: window capture first (the popover), then the textarea. */
async function press(key: string) {
  await act(async () => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
  await flush();
}

beforeEach(() => {
  onSend.mockReset();
  onSend.mockResolvedValue(undefined);
  onInvite.mockReset();
  onStop.mockReset();
  uploads.uploadChatFile.mockReset();
  uploads.uploadImage.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('BotsComposer @-mentions', () => {
  it('sends an unmatched @word as typed instead of opening "Invite another Bot"', async () => {
    await render();
    await type('send the summary to @jim');
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();

    await press('Enter');
    expect(onInvite).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith('send the summary to @jim', [], []);
  });

  it('still reaches the invite row from the keyboard', async () => {
    await render();
    await type('@');
    // "@" alone lists every Bot: Sprouty is selected, ↓ moves to the invite row.
    await press('ArrowDown');
    await press('Enter');
    expect(onInvite).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
    // A bare "@" was only the way in — it goes.
    expect(textarea().value).toBe('');
  });

  it('keeps typed words when inviting from an unmatched @word', async () => {
    await render();
    await type('ask @jim');
    await press('ArrowDown');
    await press('Enter');
    expect(onInvite).toHaveBeenCalledTimes(1);
    expect(textarea().value).toBe('ask @jim');
  });

  it('inserts the Bot mention on Enter when the name matches', async () => {
    await render();
    await type('@Spr');
    await press('Enter');
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea().value).toContain('@Sprouty');
  });
});

describe('BotsComposer attachments', () => {
  it('turns a non-image file into a chip and sends it as the attachments fence', async () => {
    uploads.uploadChatFile.mockResolvedValue({ id: 'cf_1', name: 'sales.csv', size: 12 });
    await render();

    const csv = new File(['a,b\n1,2\n'], 'sales.csv', { type: 'text/csv' });
    await act(async () => handle.current?.addFiles([csv]));
    await flush();
    expect(document.body.textContent).toContain('sales.csv');
    expect(uploads.uploadImage).not.toHaveBeenCalled();

    await type('Analyse this CSV');
    await press('Enter');

    expect(uploads.uploadChatFile).toHaveBeenCalledWith('dm-1', csv);
    expect(onSend).toHaveBeenCalledTimes(1);
    const [content] = onSend.mock.calls[0];
    expect(content).toBe(
      'Analyse this CSV\n\n```attachments\n' +
        JSON.stringify([{ id: 'cf_1', name: 'sales.csv', size_bytes: 12 }]) +
        '\n```',
    );
    // Sent: the chip is gone.
    expect(document.body.textContent).not.toContain('sales.csv');
  });

  it('gives the draft and the uploaded chip back when the send fails, without uploading twice', async () => {
    uploads.uploadChatFile.mockResolvedValue({ id: 'cf_1', name: 'sales.csv', size: 12 });
    onSend.mockRejectedValueOnce(new Error('offline'));
    await render();

    await act(async () => handle.current?.addFiles([new File(['x'], 'sales.csv', { type: 'text/csv' })]));
    await type('Analyse this CSV');
    await press('Enter');
    expect(textarea().value).toBe('Analyse this CSV');
    expect(document.body.textContent).toContain('sales.csv');

    await press('Enter');
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(uploads.uploadChatFile).toHaveBeenCalledTimes(1);
  });

  it('sends a file on its own — the fence is the whole message', async () => {
    uploads.uploadChatFile.mockResolvedValue({ id: 'cf_2', name: 'notes.txt', size: 1 });
    await render();
    await act(async () => handle.current?.addFiles([new File(['x'], 'notes.txt', { type: 'text/plain' })]));
    await flush();
    const send = document.querySelector<HTMLButtonElement>('[data-testid="chat-send"]');
    expect(send?.disabled).toBe(false);

    await press('Enter');
    expect(onSend).toHaveBeenCalledWith(
      '```attachments\n' + JSON.stringify([{ id: 'cf_2', name: 'notes.txt', size_bytes: 1 }]) + '\n```',
      [],
      [],
    );
  });

  it('sends a pasted picture on its own, with no words', async () => {
    uploads.uploadImage.mockResolvedValue({ id: 'img_1', url: '/api/upload/img_1' });
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    await render();
    await act(async () => handle.current?.addFiles([new File(['png'], 'shot.png', { type: 'image/png' })]));
    await flush();
    expect(createObjectURL).toHaveBeenCalled();

    await press('Enter');
    expect(onSend).toHaveBeenCalledWith('', [{ id: 'img_1', url: '/api/upload/img_1' }], []);
    vi.restoreAllMocks();
  });

  it('does nothing on an Enter with nothing to send', async () => {
    await render();
    await press('Enter');
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('BotsComposer Stop', () => {
  const stop = () => document.querySelector<HTMLButtonElement>('[data-testid="bots-stop"]');

  it('shows no Stop while nothing runs', async () => {
    await render();
    expect(stop()).toBeNull();
  });

  it('first stops after the current step, then offers to stop at once', async () => {
    await render({ busy: true });
    expect(stop()?.getAttribute('aria-label')).toBe('Stop after this step');
    // Its own control, apart from Send.
    expect(document.querySelector('[data-testid="bots-stop-control"]')?.contains(stop()!)).toBe(true);
    await act(async () => stop()?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onStop).toHaveBeenCalledTimes(1);

    await render({ busy: true, stopPhase: 'soft' });
    expect(stop()?.textContent).toBe('Stopping…');
    expect(stop()?.title).toBe('Click again to stop right away');
    expect(stop()?.disabled).toBe(false);
    await act(async () => stop()?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onStop).toHaveBeenCalledTimes(2);

    await render({ busy: true, stopPhase: 'hard' });
    expect(stop()?.textContent).toBe('Stopping…');
    expect(stop()?.disabled).toBe(true);
  });

  it('keeps sending while Bots work', async () => {
    await render({ busy: true });
    await type('one more thing');
    await press('Enter');
    expect(onSend).toHaveBeenCalledWith('one more thing', [], []);
  });
});
