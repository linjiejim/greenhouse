import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@greenhouse/db';
import type { ComputerDeps, ComputerTurn } from '../../computer/browser-session.js';
import { ComputerUnavailableError } from '../../computer/access.js';

const storage = vi.hoisted(() => ({
  putObjectAtKey: vi.fn(async () => undefined),
  deleteObjectAtKey: vi.fn(async () => undefined),
  putUpload: vi.fn(async () => undefined),
  getObjectAtKey: vi.fn(async (_key: string): Promise<{ buffer: Buffer; contentType: string } | null> => null),
}));
vi.mock('../../../storage/uploads.js', () => storage);
vi.mock('../../computer/runtime.js', () => ({
  computerStatusFor: vi.fn(async () => ({
    runtime: { state: 'ready', reason: null, hardened: false },
    state: 'running',
    state_reason: null,
    controller: 'bot',
    controller_since: null,
    last_active_at: '2026-10-05T00:00:00.000Z',
    queue_position: null,
    disk_bytes: null,
  })),
}));

const { capOutput, decodeText, resolveAgentPath, runComputerAction } = await import('../computer.js');

function setup(overrides: Partial<ComputerDeps> = {}, turnOverrides: Partial<ComputerTurn> = {}) {
  const lease = { controller: 'bot' as 'bot' | 'user', epoch: 0 };
  const deps: ComputerDeps = {
    getBrowser: async () => {
      throw new Error('no browser in this test');
    },
    ensureReady: vi.fn(async () => undefined),
    trackAction: (_userId, signal) => ({ signal, done: () => undefined }),
    currentLease: async () => ({ ...lease }),
    touch: vi.fn(async () => undefined),
    remember: () => undefined,
    redact: (_u, text) => text.split('vault-secret').join('[REDACTED]'),
    isRunning: async () => true,
    exec: vi.fn(async () => ({ exitCode: 0, stdout: 'ok\n', stderr: '', truncated: false, timedOut: false })),
    readFile: vi.fn(async () => Buffer.from('hello file')),
    writeFile: vi.fn(async () => undefined),
    storeScreenshot: async () => ({
      file_id: 'cf_x',
      name: 'x.png',
      size: 1,
      download_url: '/api/chat-files/cf_x/content',
    }),
    ...overrides,
  };
  const chatFiles = {
    create: vi.fn(async (input: Record<string, unknown>) => ({ id: 'cf_1', ...input })),
    /** Attachments of sess_1 only, like the service's session bound. */
    listBySessionAndIds: vi.fn(async (sessionId: string, ids: string[]) =>
      sessionId === 'sess_1'
        ? ids
            .filter((id) => id === 'cf_upload')
            .map((id) => ({ id, name: '报告 Q3.xlsx', size: 6, storage_key: 'chat-files/u1/x/报告 Q3.xlsx' }))
        : [],
    ),
  };
  const turn: ComputerTurn = {
    db: { chatFiles } as unknown as DatabaseProvider,
    userId: 'u1',
    botId: 'bot_1',
    sessionId: 'sess_1',
    turnId: 't1',
    background: false,
    signal: new AbortController().signal,
    markTainted: vi.fn(),
    noteObservation: vi.fn(),
    vaultMatches: null,
    ...turnOverrides,
  };
  return { deps, turn, lease, chatFiles };
}

beforeEach(() => {
  storage.putObjectAtKey.mockClear();
  storage.deleteObjectAtKey.mockClear();
  storage.getObjectAtKey.mockReset().mockResolvedValue(null);
});

describe('path helpers', () => {
  it('resolves relative paths in ~/work and ~ to the agent home', () => {
    expect(resolveAgentPath('report.csv')).toBe('/home/agent/work/report.csv');
    expect(resolveAgentPath('~/Downloads/a.pdf')).toBe('/home/agent/Downloads/a.pdf');
    expect(resolveAgentPath('../../../etc/passwd')).toBe('/etc/passwd');
    expect(resolveAgentPath('/tmp/x')).toBe('/tmp/x');
  });

  it('tells text from binary', () => {
    expect(decodeText(Buffer.from('héllo 你好'))).toBe('héllo 你好');
    expect(decodeText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))).toBeNull();
    expect(decodeText(Buffer.from([0xff, 0xfe, 0xfd]))).toBeNull();
  });

  it('caps long output keeping head and tail', () => {
    const out = capOutput(Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n'), 500);
    expect(out).toContain('line 0');
    expect(out).toContain('line 4999');
    expect(out).toMatch(/lines omitted — narrow it down/);
  });
});

describe('shell', () => {
  it('runs as agent in ~/work with a clamped timeout, redacts, caps and taints', async () => {
    const { deps, turn } = setup({
      exec: vi.fn(async () => ({
        exitCode: 0,
        stdout: `token=vault-secret\n${'x\n'.repeat(20_000)}`,
        stderr: '',
        truncated: true,
        timedOut: false,
      })),
    });
    const result = (await runComputerAction(
      turn,
      { action: 'shell', command: 'cat big.txt', timeout_s: 500 },
      deps,
    )) as Record<string, unknown>;
    const [userId, script, opts] = vi.mocked(deps.exec).mock.calls[0]!;
    expect(userId).toBe('u1');
    expect(script).toMatch(/^cd \/home\/agent\/work 2>\/dev\/null \|\| \{ mkdir -p/);
    expect(script.endsWith('\ncat big.txt')).toBe(true);
    expect(opts).toMatchObject({ timeoutSec: 120, user: 'agent' });
    expect(result).toMatchObject({ exit_code: 0, truncated: true });
    expect(String(result.stdout)).toContain('token=[REDACTED]');
    expect(String(result.stdout)).toMatch(/lines omitted/);
    expect(turn.markTainted).toHaveBeenCalled();
    // Outside content with no origin: a later vault fill in this turn must ask.
    expect(turn.noteObservation).toHaveBeenCalledWith(null);
  });

  it('defaults to 60 s and explains a timeout', async () => {
    const { deps, turn } = setup({
      exec: vi.fn(async () => ({ exitCode: null, stdout: '', stderr: '', truncated: false, timedOut: true })),
    });
    const result = (await runComputerAction(turn, { action: 'shell', command: 'sleep 999' }, deps)) as Record<
      string,
      unknown
    >;
    expect(vi.mocked(deps.exec).mock.calls[0]![2].timeoutSec).toBe(60);
    expect(result).toMatchObject({ timed_out: true });
    expect(String(result.note)).toMatch(/Killed after 60 s/);
    // A background job must detach all three streams, or it keeps the exec
    // attached and dies at the timeout (plain `nohup cmd &` does not).
    expect(String(result.note)).toContain('2>&1');
    expect(String(result.note)).toContain('< /dev/null');
    expect(String(result.note)).not.toMatch(/nohup … &/);
  });

  it('tells the model how to start long jobs before it ever hits a timeout', async () => {
    const { createComputerTool } = await import('../computer.js');
    const { turn, deps } = setup();
    const schema = createComputerTool(turn, deps).inputSchema as unknown as {
      shape: { command: { description?: string } };
    };
    expect(schema.shape.command.description).toMatch(/setsid -f .*2>&1 < \/dev\/null/);
  });

  it('checks the lease again once the computer is up: a take-over during the start wins', async () => {
    const { deps, turn, lease } = setup();
    vi.mocked(deps.ensureReady).mockImplementationOnce(async () => {
      lease.controller = 'user'; // the member took over while the computer was starting
    });
    expect(await runComputerAction(turn, { action: 'shell', command: 'rm -rf ~/work/x' }, deps)).toMatchObject({
      code: 'user_in_control',
    });
    expect(deps.ensureReady).toHaveBeenCalledWith('u1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(deps.exec).not.toHaveBeenCalled();
  });

  it('runs the command under the tracked signal, so a take-over in this process kills it', async () => {
    const tracked = new AbortController();
    const done = vi.fn();
    const { deps, turn } = setup({ trackAction: () => ({ signal: tracked.signal, done }) });
    await runComputerAction(turn, { action: 'shell', command: 'ls' }, deps);
    expect(vi.mocked(deps.exec).mock.calls[0]![2].signal).toBe(tracked.signal);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('refuses while the member holds the computer, but status still answers', async () => {
    const { deps, turn, lease } = setup();
    lease.controller = 'user';
    expect(await runComputerAction(turn, { action: 'shell', command: 'ls' }, deps)).toMatchObject({
      code: 'user_in_control',
    });
    expect(deps.exec).not.toHaveBeenCalled();
    expect(await runComputerAction(turn, { action: 'status' }, deps)).toMatchObject({
      state: 'running',
      runtime: 'ready',
    });
  });

  it('maps an unavailable computer to a friendly failure', async () => {
    const { deps, turn } = setup({
      exec: vi.fn(async () => {
        throw new ComputerUnavailableError('busy', 'queue full');
      }),
    });
    const result = await runComputerAction(turn, { action: 'shell', command: 'ls' }, deps);
    expect(result).toMatchObject({ code: 'busy' });
    expect(String(result.error)).toMatch(/in use/);
  });
});

describe('files', () => {
  it('reads text files, refusing binary and oversized ones', async () => {
    const { deps, turn } = setup();
    expect(await runComputerAction(turn, { action: 'read_file', path: 'notes.txt' }, deps)).toMatchObject({
      path: '/home/agent/work/notes.txt',
      content: 'hello file',
    });
    expect(turn.noteObservation).toHaveBeenCalledWith(null);
    vi.mocked(deps.readFile).mockResolvedValueOnce(Buffer.from([0, 1, 2]));
    expect(await runComputerAction(turn, { action: 'read_file', path: 'a.bin' }, deps)).toMatchObject({
      code: 'binary',
    });
    vi.mocked(deps.readFile).mockResolvedValueOnce(Buffer.alloc(256 * 1024 + 1, 'a'));
    expect(await runComputerAction(turn, { action: 'read_file', path: 'big.txt' }, deps)).toMatchObject({
      code: 'too_large',
    });
  });

  it('writes only inside the agent home and within 1 MiB', async () => {
    const { deps, turn } = setup();
    expect(
      await runComputerAction(turn, { action: 'write_file', path: 'out/a.txt', content: 'hi' }, deps),
    ).toMatchObject({
      path: '/home/agent/work/out/a.txt',
      written: true,
    });
    expect(vi.mocked(deps.writeFile).mock.calls[0]![2].toString()).toBe('hi');
    for (const path of ['/etc/cron.d/x', '../../../etc/passwd', '/home/agentx/a', '/home/browser/chromium/Cookies']) {
      expect(await runComputerAction(turn, { action: 'write_file', path, content: 'x' }, deps)).toMatchObject({
        code: 'forbidden_path',
      });
    }
    expect(
      await runComputerAction(turn, { action: 'write_file', path: 'big', content: 'x'.repeat(1024 * 1024 + 1) }, deps),
    ).toMatchObject({ code: 'too_large' });
  });

  it('shares a file as a chat attachment of this conversation', async () => {
    const { deps, turn, chatFiles } = setup({ readFile: vi.fn(async () => Buffer.from('%PDF-1.7 ...')) });
    const result = await runComputerAction(turn, { action: 'share_file', path: '~/Downloads/Invoice 九月.pdf' }, deps);
    expect(result).toMatchObject({
      type: 'file',
      file_id: 'cf_1',
      name: 'Invoice 九月.pdf',
      content_type: 'application/pdf',
      download_url: '/api/chat-files/cf_1/content',
    });
    const [key, , contentType] = storage.putObjectAtKey.mock.calls[0] as unknown as [string, Buffer, string];
    expect(key).toMatch(/^chat-files\/u1\/[0-9a-f-]{36}\/Invoice 九月\.pdf$/);
    expect(contentType).toBe('application/pdf');
    expect(chatFiles.create).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'sess_1', source: 'agent', created_by: 'u1', storage_key: key }),
    );
  });

  it('refuses to share outside the home or over 20 MB, and cleans up a failed row', async () => {
    const { deps, turn, chatFiles } = setup();
    expect(await runComputerAction(turn, { action: 'share_file', path: '/etc/passwd' }, deps)).toMatchObject({
      code: 'forbidden_path',
    });
    vi.mocked(deps.readFile).mockResolvedValueOnce(Buffer.alloc(20 * 1024 * 1024 + 1));
    expect(await runComputerAction(turn, { action: 'share_file', path: 'huge.zip' }, deps)).toMatchObject({
      code: 'too_large',
    });
    chatFiles.create.mockRejectedValueOnce(new Error('db down'));
    expect(await runComputerAction(turn, { action: 'share_file', path: 'a.txt' }, deps)).toMatchObject({
      code: 'failed',
    });
    expect(storage.deleteObjectAtKey).toHaveBeenCalled();
  });
});

describe('member at the computer', () => {
  it('leaves a card when the member holds the computer, and says the hand-back wakes the Bot', async () => {
    const implicitTakeover = vi.fn(async () => 'card' as const);
    const { deps, turn, lease } = setup({}, { implicitTakeover });
    lease.controller = 'user';
    const result = await runComputerAction(turn, { action: 'shell', command: 'ls' }, deps);
    expect(result).toMatchObject({ code: 'user_in_control' });
    expect(String(result.error)).toMatch(/A card asks them to hand it back.*woken automatically/);
    expect(implicitTakeover).toHaveBeenCalledWith({ reason: 'waiting' });
    expect(deps.ensureReady).not.toHaveBeenCalled();
  });

  it('a take-over that kills a running command discards its output and leaves an interrupted card', async () => {
    const tracked = new AbortController();
    const implicitTakeover = vi.fn(async () => 'card' as const);
    const { deps, turn, lease } = setup(
      {
        trackAction: () => ({ signal: tracked.signal, done: () => undefined }),
        // A killed command returns like a finished one (runShell does not throw).
        exec: vi.fn(async (_u: string, _c: string, opts: { signal?: AbortSignal }) => {
          await new Promise((resolve) => opts.signal!.addEventListener('abort', resolve, { once: true }));
          return {
            exitCode: null,
            stdout: 'half-written secret output',
            stderr: '',
            truncated: false,
            timedOut: false,
          };
        }),
      },
      { implicitTakeover },
    );
    const running = runComputerAction(turn, { action: 'shell', command: 'long-job' }, deps);
    await vi.waitFor(() => expect(deps.exec).toHaveBeenCalled());
    // What takeoverComputer does: the lease goes to the member, then work in flight is aborted.
    lease.controller = 'user';
    const { ComputerActionsAbortedError } = await import('../../computer/access.js');
    tracked.abort(new ComputerActionsAbortedError('takeover'));
    const result = await running;
    expect(result).toMatchObject({ code: 'user_in_control' });
    expect(JSON.stringify(result)).not.toContain('half-written');
    expect(String(result.error)).toMatch(/took over the computer while you were working/);
    expect(implicitTakeover).toHaveBeenCalledWith({ reason: 'interrupted' });
    expect(turn.markTainted).not.toHaveBeenCalled();
  });

  it('promises no wake-up in a background task (nobody would wake it)', async () => {
    const { deps, turn, lease } = setup({}, { background: true });
    lease.controller = 'user';
    const result = await runComputerAction(turn, { action: 'read_file', path: 'a.txt' }, deps);
    expect(result).toMatchObject({ code: 'user_in_control' });
    expect(String(result.error)).not.toMatch(/woken/);
  });
});

describe('import_attachment', () => {
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]); // binary, with a NUL

  it('copies an attachment of this conversation into ~/work/inbox, byte for byte, without tainting the turn', async () => {
    storage.getObjectAtKey.mockResolvedValueOnce({ buffer: bytes, contentType: 'application/octet-stream' });
    const { deps, turn, chatFiles } = setup();
    const result = await runComputerAction(turn, { action: 'import_attachment', file_id: 'cf_upload' }, deps);
    expect(result).toEqual({ path: '/home/agent/work/inbox/报告 Q3.xlsx', size: 6, name: '报告 Q3.xlsx' });
    expect(chatFiles.listBySessionAndIds).toHaveBeenCalledWith('sess_1', ['cf_upload']);
    expect(storage.getObjectAtKey).toHaveBeenCalledWith('chat-files/u1/x/报告 Q3.xlsx');
    const [userId, path, written, opts] = vi.mocked(deps.writeFile).mock.calls[0]!;
    expect([userId, path]).toEqual(['u1', '/home/agent/work/inbox/报告 Q3.xlsx']);
    expect(Buffer.compare(written, bytes)).toBe(0);
    expect(opts?.signal).toBeInstanceOf(AbortSignal); // tracked: a take-over stops the copy
    // Member-provided content in the vault's ledger; nothing was shown, so not tainted.
    expect(turn.noteObservation).toHaveBeenCalledWith(null);
    expect(turn.markTainted).not.toHaveBeenCalled();
  });

  it('puts it where asked inside ~/work, and nowhere else', async () => {
    storage.getObjectAtKey.mockResolvedValue({ buffer: bytes, contentType: 'application/octet-stream' });
    const { deps, turn } = setup();
    expect(
      await runComputerAction(turn, { action: 'import_attachment', file_id: 'cf_upload', path: 'data/q3.xlsx' }, deps),
    ).toMatchObject({ path: '/home/agent/work/data/q3.xlsx' });
    expect(
      await runComputerAction(turn, { action: 'import_attachment', file_id: 'cf_upload', path: '~/work/in/' }, deps),
    ).toMatchObject({ path: '/home/agent/work/in/报告 Q3.xlsx' });
    for (const path of ['~/Downloads/x', '/etc/cron.d/x', '../x', '~/work', '/home/browser/x']) {
      expect(
        await runComputerAction(turn, { action: 'import_attachment', file_id: 'cf_upload', path }, deps),
      ).toMatchObject({ code: 'forbidden_path' });
    }
    expect(deps.writeFile).toHaveBeenCalledTimes(2);
  });

  it('finds only attachments of this conversation, and caps the size like share_file', async () => {
    const { deps, turn, chatFiles } = setup();
    expect(await runComputerAction(turn, { action: 'import_attachment', file_id: 'cf_elsewhere' }, deps)).toMatchObject(
      { code: 'not_found' },
    );
    expect(await runComputerAction(turn, { action: 'import_attachment' }, deps)).toMatchObject({ code: 'invalid' });
    // Stored bytes gone.
    expect(await runComputerAction(turn, { action: 'import_attachment', file_id: 'cf_upload' }, deps)).toMatchObject({
      code: 'not_found',
    });
    chatFiles.listBySessionAndIds.mockResolvedValueOnce([
      { id: 'cf_upload', name: 'big.zip', size: 20 * 1024 * 1024 + 1, storage_key: 'k' },
    ] as never);
    expect(await runComputerAction(turn, { action: 'import_attachment', file_id: 'cf_upload' }, deps)).toMatchObject({
      code: 'too_large',
    });
    storage.getObjectAtKey.mockResolvedValueOnce({ buffer: Buffer.alloc(20 * 1024 * 1024 + 1), contentType: 'x' });
    expect(await runComputerAction(turn, { action: 'import_attachment', file_id: 'cf_upload' }, deps)).toMatchObject({
      code: 'too_large',
    });
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('is offered to interactive turns only', async () => {
    const { createComputerTool } = await import('../computer.js');
    const fg = setup();
    const foreground = createComputerTool(fg.turn, fg.deps);
    expect(foreground.description).toMatch(/import_attachment \{file_id, path\?\}/);
    const fgSchema = foreground.inputSchema as unknown as { safeParse(v: unknown): { success: boolean } };
    expect(fgSchema.safeParse({ action: 'import_attachment', file_id: 'cf_upload' }).success).toBe(true);
    const bg = setup({}, { background: true });
    const bgSchema = createComputerTool(bg.turn, bg.deps).inputSchema as unknown as {
      safeParse(v: unknown): { success: boolean };
    };
    expect(bgSchema.safeParse({ action: 'import_attachment', file_id: 'cf_upload' }).success).toBe(false);
    expect(
      await runComputerAction(bg.turn, { action: 'import_attachment', file_id: 'cf_upload' }, bg.deps),
    ).toMatchObject({ code: 'not_allowed' });
    expect(bg.deps.writeFile).not.toHaveBeenCalled();
  });
});

describe('background turns', () => {
  it('only allow status and read_file', async () => {
    const { deps, turn } = setup({}, { background: true });
    for (const action of ['shell', 'write_file', 'share_file'] as const) {
      expect(await runComputerAction(turn, { action, path: 'a', command: 'ls', content: 'x' }, deps)).toMatchObject({
        code: 'not_allowed',
      });
    }
    expect(await runComputerAction(turn, { action: 'read_file', path: 'a.txt' }, deps)).toMatchObject({
      content: 'hello file',
    });
  });
});
