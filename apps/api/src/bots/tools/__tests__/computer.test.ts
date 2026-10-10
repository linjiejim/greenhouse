import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@greenhouse/db';
import type { ComputerDeps, ComputerTurn } from '../../computer/browser-session.js';
import { ComputerUnavailableError } from '../../computer/access.js';

// Preview tickets are signed with the deployment's token key.
process.env.TOKEN_SIGNING_KEY ??= randomBytes(32).toString('hex');

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
    startJob: vi.fn(async (_userId: string, input: { command: string; name?: string }) => ({
      id: 'j0000beef',
      name: input.name ?? input.command.split(' ')[0]!,
      pid: 4242,
      started_at: '2026-10-07T01:00:00Z',
    })),
    listJobs: vi.fn(async () => []),
    jobLog: vi.fn(async (_userId: string, id: string) => ({ id, text: 'step 1\nstep 2\n', truncated: false })),
    stopJob: vi.fn(async (_userId: string, id: string) => ({ id, stopped: true })),
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
  const botComputers = { watchProcess: vi.fn(async () => undefined) };
  const users = { getById: vi.fn(async (id: string) => (id === 'u1' ? { id: 'u1', auth_version: 3 } : undefined)) };
  const turn: ComputerTurn = {
    db: { chatFiles, botComputers, users } as unknown as DatabaseProvider,
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
  return { deps, turn, lease, chatFiles, botComputers };
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
    // Long work goes to a background process, not a hand-rolled detached job.
    expect(String(result.note)).toMatch(/use run_background \{command\}/);
    expect(String(result.note)).toMatch(/process_log/);
    expect(String(result.note)).not.toMatch(/setsid|nohup/);
  });

  it('tells the model how to start long work before it ever hits a timeout', async () => {
    const { createComputerTool } = await import('../computer.js');
    const { turn, deps } = setup();
    const tool = createComputerTool(turn, deps);
    const schema = tool.inputSchema as unknown as { shape: { command: { description?: string } } };
    expect(schema.shape.command.description).toMatch(/≤120 s\). run_background: the command/);
    expect(tool.description).toMatch(/run_background \{command, name\?\}/);
    expect(tool.description).not.toMatch(/setsid/);
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

describe('what the Bot is told about its computer', () => {
  it('says what sleep does to running work on this host, and that localhost stays inside', async () => {
    const { createComputerTool } = await import('../computer.js');
    const { turn, deps } = setup();
    const docker = createComputerTool(turn, deps, 'docker').description!;
    const hosted = createComputerTool(turn, deps, 'e2b').description!;
    expect(docker).toMatch(/running processes end/);
    expect(hosted).toMatch(/everything is frozen, running processes included, and carries on when it wakes/);
    expect(hosted).not.toMatch(/running processes end —/);
    for (const description of [docker, hosted]) {
      expect(description).toMatch(/Your whole home persists, not only ~\/work/);
      expect(description).toMatch(/never give the member its localhost address/);
      expect(description).toMatch(/preview \{port\}/);
    }
    // The default (an existing caller, the docker host) keeps the docker wording.
    expect(createComputerTool(turn, deps).description).toBe(docker);
  });

  it('watches a background process for the Bot that started it, and says it will be woken', async () => {
    const { deps, turn, botComputers } = setup();
    const result = await runComputerAction(turn, { action: 'run_background', command: 'make', name: 'build' }, deps);
    expect(botComputers.watchProcess).toHaveBeenCalledWith({
      user_id: 'u1',
      session_id: 'sess_1',
      bot_id: 'bot_1',
      job_id: 'j0000beef',
      name: 'build',
    });
    expect(result).toMatchObject({ note: expect.stringMatching(/When it ends you are woken up in this conversation/) });
  });

  it('a watch that could not be recorded makes the Bot not promise anything', async () => {
    const { deps, turn, botComputers } = setup();
    botComputers.watchProcess.mockRejectedValueOnce(new Error('db down'));
    const result = await runComputerAction(turn, { action: 'run_background', command: 'make' }, deps);
    expect(result).toMatchObject({
      id: 'j0000beef',
      note: expect.stringMatching(/Nothing will tell you when it ends/),
    });
  });
});

describe('port previews', () => {
  it('gives the member a ticketed link for a port, bound to them and that port', async () => {
    const { verifyPreviewTicket } = await import('../../computer/preview.js');
    const { deps, turn } = setup();
    const result = (await runComputerAction(turn, { action: 'preview', port: 8000 }, deps)) as {
      url: string;
      note: string;
    };
    const [, , token, port] = result.url.split('/').slice(1);
    expect(result.url).toMatch(/^\/api\/bots-preview\/[^/]+\/8000\/$/);
    expect(port).toBe('8000');
    expect(verifyPreviewTicket(token!, 8000)).toMatchObject({ uid: 'u1', av: 3, p: 8000 });
    expect(result.note).toMatch(/relative paths/);
  });

  it('refuses a port a preview may not open', async () => {
    const { deps, turn } = setup();
    for (const port of [80, 7681, 49983]) {
      expect(await runComputerAction(turn, { action: 'preview', port }, deps)).toMatchObject({ code: 'invalid' });
    }
    expect(await runComputerAction(turn, { action: 'preview' }, deps)).toMatchObject({ code: 'invalid' });
  });
});

describe('background turns', () => {
  it('only allow status, read_file, processes and process_log', async () => {
    const { deps, turn } = setup({}, { background: true });
    for (const action of ['shell', 'write_file', 'share_file', 'run_background', 'stop_process'] as const) {
      expect(
        await runComputerAction(turn, { action, path: 'a', command: 'ls', content: 'x', id: 'j0000beef' }, deps),
      ).toMatchObject({ code: 'not_allowed' });
    }
    expect(deps.startJob).not.toHaveBeenCalled();
    expect(deps.stopJob).not.toHaveBeenCalled();
    expect(await runComputerAction(turn, { action: 'read_file', path: 'a.txt' }, deps)).toMatchObject({
      content: 'hello file',
    });
    expect(await runComputerAction(turn, { action: 'processes' }, deps)).toMatchObject({ processes: [] });
    expect(await runComputerAction(turn, { action: 'process_log', id: 'j0000beef' }, deps)).toMatchObject({
      id: 'j0000beef',
      text: 'step 1\nstep 2\n',
    });
  });

  it('offer the process readers in the schema, never run_background or stop_process', async () => {
    const { createComputerTool } = await import('../computer.js');
    const bg = setup({}, { background: true });
    const tool = createComputerTool(bg.turn, bg.deps);
    const schema = tool.inputSchema as unknown as { safeParse(v: unknown): { success: boolean } };
    expect(schema.safeParse({ action: 'processes' }).success).toBe(true);
    expect(schema.safeParse({ action: 'process_log', id: 'j0000beef', lines: 50 }).success).toBe(true);
    expect(schema.safeParse({ action: 'run_background', command: 'make' }).success).toBe(false);
    expect(schema.safeParse({ action: 'stop_process', id: 'j0000beef' }).success).toBe(false);
    expect(tool.description).toMatch(/only status, read_file, processes and process_log work/);
  });
});

describe('background processes', () => {
  it('run_background starts a job in the running computer, under the tracked signal', async () => {
    const tracked = new AbortController();
    const { deps, turn } = setup({ trackAction: () => ({ signal: tracked.signal, done: () => undefined }) });
    const result = await runComputerAction(
      turn,
      { action: 'run_background', command: 'pip install pandas && python3 train.py', name: 'train' },
      deps,
    );
    expect(deps.ensureReady).toHaveBeenCalled();
    expect(deps.startJob).toHaveBeenCalledWith(
      'u1',
      { command: 'pip install pandas && python3 train.py', name: 'train' },
      { signal: tracked.signal },
    );
    expect(result).toMatchObject({ id: 'j0000beef', name: 'train', status: 'running' });
    expect(String((result as Record<string, unknown>).note)).toMatch(/process_log \{id: "j0000beef"\}/);
    expect(await runComputerAction(turn, { action: 'run_background', command: '  ' }, deps)).toMatchObject({
      code: 'invalid',
    });
  });

  it('run_background is refused while the member holds the computer, and a take-over during the start says so', async () => {
    const { deps, turn, lease } = setup();
    lease.controller = 'user';
    expect(await runComputerAction(turn, { action: 'run_background', command: 'make' }, deps)).toMatchObject({
      code: 'user_in_control',
    });
    expect(deps.startJob).not.toHaveBeenCalled();

    lease.controller = 'bot';
    const tracked = new AbortController();
    const { ComputerActionsAbortedError } = await import('../../computer/access.js');
    const killed = setup({
      trackAction: () => ({ signal: tracked.signal, done: () => undefined }),
      // gh-jobs killed mid-start reports a plain failure (exit -1).
      startJob: vi.fn(async () => {
        killed.lease.controller = 'user';
        tracked.abort(new ComputerActionsAbortedError('takeover'));
        throw new Error('Starting the job failed (exit -1)');
      }),
    });
    const result = await runComputerAction(killed.turn, { action: 'run_background', command: 'make' }, killed.deps);
    expect(result).toMatchObject({ code: 'user_in_control' });
    expect(String(result.error)).not.toMatch(/exit -1/);
  });

  it('processes lists jobs redacted and trimmed, never starting the computer, and taints the turn', async () => {
    const job = (i: number, extra: Record<string, unknown> = {}) => ({
      id: `j${String(i).padStart(8, '0')}`,
      name: `job ${i}`,
      command: `printf 'token: vault-secret' > note-${i}.txt`,
      cwd: '/home/agent/work',
      status: 'running' as const,
      exit_code: null,
      started_at: '2026-10-07T01:00:00Z',
      ended_at: null,
      log_bytes: 10,
      ...extra,
    });
    const { deps, turn } = setup({
      listJobs: vi.fn(async () => [
        job(1, { command: `python3 -c "${'x'.repeat(1000)}"` }),
        job(2, { status: 'lost' }),
        ...Array.from({ length: 23 }, (_, i) => job(i + 3)),
      ]),
    });
    const result = (await runComputerAction(turn, { action: 'processes' }, deps)) as {
      processes: Array<Record<string, unknown>>;
      more?: number;
      note?: string;
    };
    expect(deps.ensureReady).not.toHaveBeenCalled();
    expect(result.processes).toHaveLength(20);
    expect(result.more).toBe(5);
    expect(String(result.processes[0]!.command).length).toBeLessThanOrEqual(301);
    expect(String(result.processes[1]!.command)).toContain('token: [REDACTED]');
    expect(JSON.stringify(result)).not.toContain('vault-secret');
    expect(result.note).toMatch(/lost = it was running when the computer stopped/);
    expect(turn.markTainted).toHaveBeenCalled();
    expect(turn.noteObservation).toHaveBeenCalledWith(null);

    const none = setup();
    expect(await runComputerAction(none.turn, { action: 'processes' }, none.deps)).toMatchObject({
      processes: [],
      note: expect.stringMatching(/No background processes/),
    });
  });

  it('process_log returns the end of the log, redacted and capped, and taints the turn', async () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `epoch ${i} loss=0.${i} key=vault-secret`).join('\n');
    const { deps, turn } = setup({
      jobLog: vi.fn(async (_u: string, id: string) => ({ id, text: lines, truncated: true })),
    });
    const result = await runComputerAction(turn, { action: 'process_log', id: ' j0000beef ', lines: 2000 }, deps);
    expect(deps.jobLog).toHaveBeenCalledWith('u1', 'j0000beef', expect.objectContaining({ lines: 2000 }));
    const text = String((result as Record<string, unknown>).text);
    expect(text).toContain('epoch 2999'); // the newest lines survive the cap
    expect(text).not.toContain('epoch 0 ');
    expect(text).toMatch(/earlier lines omitted — the whole log is ~\/\.local\/state\/gh-jobs\/j0000beef\/log/);
    expect(text).not.toContain('vault-secret');
    expect(result).toMatchObject({ id: 'j0000beef', truncated: true });
    expect(turn.markTainted).toHaveBeenCalled();
    expect(turn.noteObservation).toHaveBeenCalledWith(null);
  });

  it('process_log and stop_process validate the id and report unknown jobs', async () => {
    const { ComputerDockerError } = await import('../../computer/docker.js');
    const unknown = vi.fn(async () => {
      throw new ComputerDockerError('not_found', 'no such job');
    });
    const { deps, turn } = setup({ jobLog: unknown, stopJob: unknown });
    for (const action of ['process_log', 'stop_process'] as const) {
      expect(await runComputerAction(turn, { action, id: '--help' }, deps)).toMatchObject({ code: 'invalid' });
      const missing = await runComputerAction(turn, { action, id: 'j12345678' }, deps);
      expect(missing).toMatchObject({ code: 'not_found' });
      expect(String(missing.error)).toMatch(/There is no process "j12345678".*processes/);
    }
    expect(turn.markTainted).not.toHaveBeenCalled();
  });

  it('stop_process stops a job without starting a stopped computer', async () => {
    const { deps, turn } = setup();
    expect(await runComputerAction(turn, { action: 'stop_process', id: 'j0000beef' }, deps)).toEqual({
      id: 'j0000beef',
      stopped: true,
    });
    vi.mocked(deps.stopJob).mockResolvedValueOnce({ id: 'j0000beef', stopped: false });
    expect(await runComputerAction(turn, { action: 'stop_process', id: 'j0000beef' }, deps)).toMatchObject({
      stopped: false,
      note: expect.stringMatching(/not running any more/),
    });
    vi.mocked(deps.stopJob).mockRejectedValueOnce(new ComputerUnavailableError('stopped', 'not running'));
    expect(await runComputerAction(turn, { action: 'stop_process', id: 'j0000beef' }, deps)).toMatchObject({
      stopped: false,
      note: expect.stringMatching(/computer is not running/),
    });
    expect(deps.ensureReady).not.toHaveBeenCalled();
  });

  it('every process action is refused while the member holds the computer', async () => {
    const { deps, turn, lease } = setup();
    lease.controller = 'user';
    for (const action of ['processes', 'process_log', 'stop_process'] as const) {
      expect(await runComputerAction(turn, { action, id: 'j0000beef' }, deps)).toMatchObject({
        code: 'user_in_control',
      });
    }
    expect(deps.listJobs).not.toHaveBeenCalled();
    expect(deps.jobLog).not.toHaveBeenCalled();
    expect(deps.stopJob).not.toHaveBeenCalled();
  });
});
