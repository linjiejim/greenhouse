/**
 * Drift guards for everything the mobile Bots client copies from the workspace (spec
 * docs/specs/20261008-mobile-bots.md §2.8). apps/mobile is outside the pnpm workspace, so shared
 * code arrives as verbatim copies; this ROOT vitest test (the mobile tsconfig excludes *.test.ts)
 * parses both sides with the repo's TypeScript and fails the moment the canonical code changes
 * without the copy following. Four kinds of guard:
 *
 * 1. File verbatim — `expectFileVendored`: every statement after the imports (JSDoc included)
 *    is identical; only import paths may differ (plus the declared inline-import rewrites).
 * 2. Declarations verbatim — `expectDeclarationsVendored`: named top-level declarations, module
 *    private ones included, compared without `export` and with whitespace normalised.
 * 3. Pinned-text tripwires — `expectPinnedText`: logic mobile ports by hand (the web keeps it
 *    inline in components) is selected by AST and its normalised text hashed here. A web change
 *    turns this red; re-check the named mobile port, then update the hash.
 * 4. Behaviour — the same inputs through canonical and copy give the same answers.
 *
 * When one fails: re-copy the canonical file / declaration into the mobile copy (never edit the
 * copy by hand), or — for a tripwire — port the change and update the pinned hash.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as canonicalBots from '@greenhouse/types/bots';
import { avatarConfigSchema } from '@greenhouse/types/profile-manifest';
import type { BotRequestView } from '@greenhouse/types/bots';
import * as webBotName from '../../../../web/src/components/bots/bot-name';
import * as webMentions from '../../../../web/src/components/bots/mentions';
import * as webTranscript from '../../../../web/src/components/bots/transcript';
import * as mobileBots from '../../shared/bots';
import type { BotMessage } from '../../shared/bots';
import type { BotStreamSegment } from '../../shared/bots-wire';
import * as mobileBotName from './bot-name';
import * as mobileMentions from './mentions';
import * as mobileTranscript from './transcript';

const ROOT = resolve(__dirname, '../../../../..');
const at = (path: string) => resolve(ROOT, path);
const MOBILE = 'apps/mobile/src';
const WEB_BOTS = 'apps/web/src/components/bots';

// ─── Source helpers ──────────────────────────────────────

function parse(path: string, rewrites: ReadonlyArray<readonly [string, string]> = []): ts.SourceFile {
  let text = readFileSync(at(path), 'utf8');
  for (const [from, to] of rewrites) text = text.split(from).join(to);
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
}

/** Every statement after the imports, with its JSDoc. */
function statementTexts(sf: ts.SourceFile): string[] {
  return sf.statements
    .filter((statement) => !ts.isImportDeclaration(statement))
    .map((statement) => sf.text.slice(statement.getStart(sf, true), statement.end));
}

function expectFileVendored(canonical: string, copy: string, rewrites: ReadonlyArray<readonly [string, string]> = []) {
  expect(statementTexts(parse(copy)), `${copy} is not a verbatim copy of ${canonical} — re-copy it`).toEqual(
    statementTexts(parse(canonical, rewrites)),
  );
}

function declaredNames(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.map((declaration) => declaration.name.getText());
  }
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  ) {
    return statement.name ? [statement.name.text] : [];
  }
  return [];
}

function declaration(sf: ts.SourceFile, name: string): ts.Statement {
  const found = sf.statements.find((statement) => declaredNames(statement).includes(name));
  if (!found) throw new Error(`${sf.fileName} declares no top-level ${name}`);
  return found;
}

const normalise = (text: string) => text.replace(/\s+/g, ' ').trim();

/** A declaration's code: no JSDoc, no `export`, whitespace normalised. */
function declarationText(sf: ts.SourceFile, name: string): string {
  return normalise(
    declaration(sf, name)
      .getText(sf)
      .replace(/^export\s+(default\s+)?/, ''),
  );
}

function expectDeclarationsVendored(canonical: string, copy: string, names: readonly string[]) {
  const [from, to] = [parse(canonical), parse(copy)];
  for (const name of names) {
    expect(declarationText(to, name), `${copy}: ${name} differs from ${canonical} — re-copy it`).toBe(
      declarationText(from, name),
    );
  }
}

function collect(sf: ts.SourceFile, keep: (node: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (keep(node)) out.push(node);
    else ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function pinnedHash(path: string, select: (sf: ts.SourceFile) => ts.Node[]): string {
  const sf = parse(path);
  const nodes = select(sf);
  if (nodes.length === 0) throw new Error(`${path}: the tripwire selected nothing — the code moved; re-pin it`);
  const text = nodes.map((node) => normalise(node.getText(sf))).join('\n');
  return createHash('sha256').update(text).digest('hex');
}

function expectPinnedText(path: string, select: (sf: ts.SourceFile) => ts.Node[], sha256: string, port: string) {
  const actual = pinnedHash(path, select);
  expect(actual, `${path} changed (now ${actual}) — re-check ${port} against it, then update the pinned hash`).toBe(
    sha256,
  );
}

// ─── 1. Files ────────────────────────────────────────────

describe('file-verbatim copies', () => {
  it('plant-avatar vocabulary + resolver', () => {
    expectFileVendored('packages/types/src/plant-avatar.ts', `${MOBILE}/ui/plant-avatar/plant-ids.ts`);
  });

  it('Bots wire types + templates (BotMessage parts come from bots-wire)', () => {
    expectFileVendored('packages/types/src/bots.ts', `${MOBILE}/shared/bots.ts`, [
      ["import('./session.js')", "import('./bots-wire')"],
    ]);
  });

  it('transcript assembly, mentions, Bot name rules', () => {
    expectFileVendored(`${WEB_BOTS}/transcript.ts`, `${MOBILE}/bots/vendor/transcript.ts`);
    expectFileVendored(`${WEB_BOTS}/mentions.ts`, `${MOBILE}/bots/vendor/mentions.ts`);
    expectFileVendored(`${WEB_BOTS}/bot-name.ts`, `${MOBILE}/bots/vendor/bot-name.ts`);
  });
});

// ─── 2. Declarations ─────────────────────────────────────

describe('declaration-verbatim copies', () => {
  it('legacy avatar id tables (avatar-config.ts)', () => {
    expectDeclarationsVendored('packages/types/src/profile-manifest.ts', `${MOBILE}/ui/plant-avatar/avatar-config.ts`, [
      'SPROUTY_COLOR_IDS',
      'SproutyColorId',
      'SPROUTY_ACCESSORY_IDS',
      'SproutyAccessoryId',
      'SPROUTY_LEAF_STYLE_IDS',
      'SproutyLeafStyleId',
      'SPROUTY_FACE_STYLE_IDS',
      'SproutyFaceStyleId',
    ]);
  });

  it('AvatarConfig spells out the zod schema (same keys, all optional)', () => {
    const sf = parse(`${MOBILE}/ui/plant-avatar/avatar-config.ts`);
    const config = declaration(sf, 'AvatarConfig') as ts.InterfaceDeclaration;
    const members = config.members.filter(ts.isPropertySignature);
    expect(members.map((member) => member.name.getText(sf)).sort()).toEqual(
      Object.keys(avatarConfigSchema.shape).sort(),
    );
    expect(members.every((member) => member.questionToken)).toBe(true);
    const palette = members.find((member) => member.name.getText(sf) === 'palette');
    expect(normalise(palette?.type?.getText(sf) ?? '')).toBe('{ body: string; leaf: string }');
    expect(Object.keys(avatarConfigSchema.shape.palette.unwrap().shape).sort()).toEqual(['body', 'leaf']);
  });

  it('run envelope, message parts and the keepalive event', () => {
    const wire = `${MOBILE}/shared/bots-wire.ts`;
    expectDeclarationsVendored('packages/types/src/session.ts', wire, ['PipelineStep', 'Reference']);
    expectDeclarationsVendored('packages/types/src/api.ts', wire, [
      'RunReplayEnvelope',
      'ChatRunStatus',
      'ChatRunInfo',
    ]);
    expectDeclarationsVendored('packages/types/src/api.ts', `${MOBILE}/shared/greenhouse-types.ts`, ['PingEvent']);
  });

  it('web Bots API responses, the stream segment and its helpers', () => {
    const wire = `${MOBILE}/shared/bots-wire.ts`;
    expectDeclarationsVendored('apps/web/src/lib/api/bots.ts', wire, [
      'BotsOverview',
      'BotMemoryView',
      'BotWriteInput',
      'ConversationPage',
    ]);
    expectDeclarationsVendored('apps/web/src/lib/session-manager.tsx', wire, [
      'BotStreamSegment',
      'settleOpenSegments',
      'snapshotSegments',
    ]);
    expectDeclarationsVendored('apps/web/src/lib/stream-events.ts', wire, ['StreamingToolCall']);
  });

  it('web component helpers (web-helpers.ts)', () => {
    const helpers = `${MOBILE}/bots/vendor/web-helpers.ts`;
    const table: Array<[string, string[]]> = [
      ['use-bot-conversation.ts', ['PAGE_SIZE', 'PendingWithBase', 'maxSeq', 'mergeLatest', 'settlePending']],
      ['bots-store.ts', ['botsById', 'conversationBotIds', 'mergeArchived', 'conversationReplyable']],
      ['navigation.ts', ['ConversationTitleCopy', 'conversationTitle']],
      ['request-decision.ts', ['implicitTakeover', 'humanCheckTakeover']],
      ['login-request-card.tsx', ['loginValues']],
      ['instructions-update-card.tsx', ['DiffLine', 'lineDiff']],
      ['conversation-header.tsx', ['hostFromInput']],
      ['bot-task-dock.tsx', ['ACTIVE', 'TASK_POSE', 'elapsed']],
      ['memory-receipts.tsx', ['MemoryReceipt', 'asRecord', 'memoryReceiptsFromCalls']],
    ];
    for (const [file, names] of table) expectDeclarationsVendored(`${WEB_BOTS}/${file}`, helpers, names);
  });

  it('the stream union names every canonical event (Bots turns included)', () => {
    const members = (path: string) => {
      const sf = parse(path);
      const union = declaration(sf, 'StreamingEvent') as ts.TypeAliasDeclaration;
      if (!ts.isUnionTypeNode(union.type)) throw new Error(`${path}: StreamingEvent is not a union`);
      return union.type.types.map((member) => member.getText(sf).replace(/^import\([^)]*\)\./, '')).sort();
    };
    expect(members(`${MOBILE}/shared/greenhouse-types.ts`)).toEqual(members('packages/types/src/api.ts'));
  });
});

// ─── 3. Pinned tripwires (hand-ported logic) ─────────────

/** The SessionManager callbacks that build a Bots run's segments (mobile: thread/run-state.ts). */
const REDUCER_CALLBACKS = new Set([
  'onTextDelta',
  'onReasoningDelta',
  'onToolCallStart',
  'onToolCallDelta',
  'onToolCall',
  'onToolResult',
  'onBotTurnStart',
  'onBotTurnEnd',
  'onBotRequest',
]);

describe('pinned tripwires', () => {
  it('web Bots stream reducer (SessionManager) ↔ mobile thread/run-state.ts', () => {
    expectPinnedText(
      'apps/web/src/lib/session-manager.tsx',
      (sf) =>
        collect(
          sf,
          (node) =>
            (ts.isIfStatement(node) && node.expression.getText(sf).includes("'run-interrupting'")) ||
            (ts.isVariableStatement(node) &&
              node.declarationList.declarations.some((d) =>
                ['speaking', 'updateCalls'].includes(d.name.getText(sf)),
              )) ||
            (ts.isPropertyAssignment(node) && REDUCER_CALLBACKS.has(node.name.getText(sf))),
        ),
      '63d654b1a11c137cf68c4632ac6f5be56f68a84dac8e4250620d7dfed1e29e21',
      'apps/mobile/src/bots/thread/run-state.ts',
    );
  });

  it('web status line (conversation-header useStatusLine) ↔ mobile thread/status-line.ts', () => {
    expectPinnedText(
      `${WEB_BOTS}/conversation-header.tsx`,
      (sf) => [declaration(sf, 'useStatusLine')],
      '4ff635b8fa565868bb9e12f6f5cafaa0e445844d31edb0ccf7b396602298dc7a',
      'apps/mobile/src/bots/thread/status-line.ts',
    );
  });

  it('web decision error reading (classifyDecisionError) ↔ mobile requests.ts classifyDecision', () => {
    expectPinnedText(
      `${WEB_BOTS}/request-decision.ts`,
      (sf) => [declaration(sf, 'ALREADY_SETTLED'), declaration(sf, 'classifyDecisionError')],
      '7936f07e7e71ea85daea438b24233a8ab71e545ef30ffb6d6cb98d195de80529',
      'apps/mobile/src/bots/requests.ts',
    );
  });

  it('web settled-card labels (settledLabelKey) ↔ mobile cards/decision.ts settledReceipt', () => {
    expectPinnedText(
      `${WEB_BOTS}/request-decision.ts`,
      (sf) => [declaration(sf, 'settledLabelKey')],
      'e608070f7d9d0ceed369ee7fce1d791150c20abf3c78cf5a7c0e30d32f397468',
      'apps/mobile/src/bots/cards/decision.ts',
    );
  });
});

// ─── 4. Behaviour ────────────────────────────────────────

describe('behaviour', () => {
  it('templates and limits are the canonical values', () => {
    expect(mobileBots.BOT_TEMPLATES).toEqual(canonicalBots.BOT_TEMPLATES);
    expect(mobileBots.SPROUTY_BOT_TEMPLATE).toEqual(canonicalBots.SPROUTY_BOT_TEMPLATE);
    expect(mobileBots.BOT_RESERVED_NAMES).toEqual(canonicalBots.BOT_RESERVED_NAMES);
    expect([
      mobileBots.BOT_NAME_MAX,
      mobileBots.BOT_ROLE_MAX,
      mobileBots.BOT_DESCRIPTION_MAX,
      mobileBots.BOT_INSTRUCTIONS_MAX,
      mobileBots.MAX_ACTIVE_BOTS,
    ]).toEqual([
      canonicalBots.BOT_NAME_MAX,
      canonicalBots.BOT_ROLE_MAX,
      canonicalBots.BOT_DESCRIPTION_MAX,
      canonicalBots.BOT_INSTRUCTIONS_MAX,
      canonicalBots.MAX_ACTIVE_BOTS,
    ]);
    for (const key of ['sprouty', 'chief', 'researcher', 'operator', 'writer', 'analyst', 'nope', null]) {
      expect(mobileBots.botTemplate(key)).toEqual(canonicalBots.botTemplate(key));
      expect(mobileBots.galleryTemplate(key)).toEqual(canonicalBots.galleryTemplate(key));
      expect(mobileBots.isSproutyBot({ template_key: key })).toBe(canonicalBots.isSproutyBot({ template_key: key }));
    }
  });

  it('the WS frames mobile reads match the server union (contract.ts ServerWsWire)', () => {
    const api = parse('packages/types/src/api.ts');
    const aliases: Record<string, string> = {
      ChatRunStatus: normalise((declaration(api, 'ChatRunStatus') as ts.TypeAliasDeclaration).type.getText(api)),
    };
    const frames = (path: string, union: string) => {
      const sf = parse(path);
      const alias = declaration(sf, union) as ts.TypeAliasDeclaration;
      if (!ts.isUnionTypeNode(alias.type)) throw new Error(`${path}: ${union} is not a union`);
      const out: Record<string, Record<string, string>> = {};
      for (const member of alias.type.types) {
        if (!ts.isTypeLiteralNode(member)) continue;
        const fields: Record<string, string> = {};
        for (const field of member.members) {
          if (!ts.isPropertySignature(field) || !field.type) continue;
          const text = normalise(field.type.getText(sf));
          const resolved = aliases[text] ?? text;
          // Literal unions compare as sets (order is cosmetic).
          fields[`${field.name.getText(sf)}${field.questionToken ? '?' : ''}`] = resolved
            .split('|')
            .map((s) => s.trim())
            .sort()
            .join(' | ');
        }
        out[fields.type] = fields;
      }
      return out;
    };
    const server = frames('packages/types/src/ws.ts', 'ServerWsEvent');
    const mobile = frames(`${MOBILE}/bots/contract.ts`, 'ServerWsWire');
    expect(Object.keys(mobile).sort()).toEqual([
      "'bots:attention'",
      "'bots:conversation'",
      "'chat:run'",
      "'connected'",
      "'ping'",
    ]);
    for (const [type, fields] of Object.entries(mobile)) expect(fields, type).toEqual(server[type]);
  });

  it('mentions read the same on both sides', () => {
    const members = [
      { id: 'bot_sage', name: 'Sage' },
      { id: 'bot_sage2', name: 'Sage Two' },
      { id: 'bot_fern', name: 'Fern' },
      { id: 'bot_juan', name: '卷卷' },
    ];
    const inputs = [
      '',
      '@Sage hi',
      '@Sage Two, and @Fern please',
      'Fern, tighten this',
      '卷卷：润色一下',
      '@卷卷 写一句秋天的诗',
      'mail me at a@Sage.com',
      '(@fern) lower case',
      '@Fern @Fern twice',
      '@Nobody here',
    ];
    for (const text of inputs) {
      expect(mobileMentions.parseMentions(text, members), text).toEqual(webMentions.parseMentions(text, members));
    }
    expect(mobileMentions.mentionToken('卷卷')).toBe(webMentions.mentionToken('卷卷'));
  });

  it('Bot names validate the same on both sides', () => {
    const context = { otherNames: ['Fern', '卷卷'], nickname: 'Jim' };
    for (const name of ['', '  ', 'Sage', 'fern', 'jim', 'System', 'a:b', 'x'.repeat(25), '卷卷', '小卷']) {
      expect(mobileBotName.validateBotName(name, context), name).toBe(webBotName.validateBotName(name, context));
    }
    for (const code of ['bot_name_taken', 'bot_name_invalid', 'bot_limit', 'other', null]) {
      expect(mobileBotName.botNameIssueFromCode(code)).toBe(webBotName.botNameIssueFromCode(code));
    }
  });
});

// The web's transcript.test.ts key fixtures, run against both copies.
describe.each([
  ['web', webTranscript],
  ['mobile', mobileTranscript],
] as const)('buildTranscript (%s)', (_side, impl) => {
  let seq = 0;
  const msg = (partial: Partial<BotMessage>): BotMessage => {
    seq += 1;
    return {
      id: partial.id ?? `m${seq}`,
      role: 'assistant',
      content: 'text',
      bot_id: null,
      bot_event: null,
      pipeline: [],
      references: [],
      reasoning: null,
      model: null,
      images: [],
      created_at: '2026-10-05T00:00:00.000Z',
      seq,
      ...partial,
    };
  };
  const segment = (partial: Partial<BotStreamSegment>): BotStreamSegment => ({
    botId: 'bot_a',
    reason: 'user',
    status: 'streaming',
    text: '',
    reasoning: '',
    toolCalls: [],
    ...partial,
  });
  const summary = (items: ReturnType<typeof impl.buildTranscript>) =>
    items.map((item) => {
      if (item.kind === 'bot') return `bot:${item.botId}${item.header ? '+h' : ''}`;
      if (item.kind === 'segment') return `seg:${item.segment.botId}${item.header ? '+h' : ''}`;
      if (item.kind === 'pending') return `pending:${item.pending.clientId}`;
      if (item.kind === 'handoff') return `handoff:${item.handoff.from}->${item.handoff.to}`;
      if (item.kind === 'request') return `request:${item.requestId}`;
      return item.kind;
    });

  it('names a DM guest only on speaker change, never the owner', () => {
    const items = impl.buildTranscript({
      conversationKind: 'direct',
      ownerBotId: 'bot_owner',
      messages: [
        msg({ role: 'user', content: 'hi' }),
        msg({ bot_id: 'bot_owner' }),
        msg({ bot_id: 'bot_guest' }),
        msg({ bot_id: 'bot_guest' }),
        msg({ bot_id: 'bot_owner' }),
      ],
    });
    expect(summary(items)).toEqual(['user', 'bot:bot_owner', 'bot:bot_guest+h', 'bot:bot_guest', 'bot:bot_owner']);
  });

  it('draws a hand-off from the trace unless an event row recorded it', () => {
    const ask = {
      step: 1,
      tool: 'team',
      input: { action: 'ask', bot_id: 'bot_b', message: 'polish this' },
      output: { action: 'ask', status: 'handed_over', to: 'bot_b' },
      duration_ms: 3,
    };
    const fromTrace = impl.buildTranscript({
      conversationKind: 'group',
      ownerBotId: null,
      messages: [msg({ bot_id: 'bot_a', pipeline: [ask] })],
    });
    expect(summary(fromTrace)).toEqual(['bot:bot_a+h', 'handoff:bot_a->bot_b']);
    const withEvent = impl.buildTranscript({
      conversationKind: 'group',
      ownerBotId: null,
      messages: [
        msg({ bot_id: 'bot_a', pipeline: [ask] }),
        msg({ role: 'system', content: 'polish this', bot_event: { kind: 'ask', from: 'bot_a', to: 'bot_b' } }),
      ],
    });
    expect(summary(withEvent)).toEqual(['bot:bot_a+h', 'handoff:bot_a->bot_b']);
  });

  it('hides a persisted segment, drops skipped ones, keeps mid-run sends in place', () => {
    const items = impl.buildTranscript({
      conversationKind: 'group',
      ownerBotId: null,
      messages: [msg({ id: 'persisted-1', bot_id: 'bot_a' }), msg({ role: 'user' })],
      segments: [
        segment({ botId: 'bot_a', status: 'completed', messageId: 'persisted-1' }),
        segment({ botId: 'bot_c', status: 'skipped' }),
        segment({ botId: 'bot_b' }),
      ],
      pending: [
        { clientId: 'mid', content: 'b', images: [], status: 'queued', afterSegment: 2 },
        { clientId: 'late', content: 'c', images: [], status: 'queued', afterSegment: 3 },
      ],
    });
    expect(summary(items)).toEqual(['bot:bot_a+h', 'user', 'pending:mid', 'seg:bot_b+h', 'pending:late']);
  });

  it('keys a card the same live and persisted; a much later row is a plain line', () => {
    const request = { id: 'brq_1', bot_id: 'bot_a', created_at: '2026-10-05T00:00:00.000Z' } as BotRequestView;
    const live = impl.buildTranscript({
      conversationKind: 'group',
      ownerBotId: null,
      messages: [],
      segments: [segment({ botId: 'bot_a', status: 'completed' })],
      liveRequests: [request],
    });
    const row = (created_at: string) =>
      msg({
        role: 'system',
        created_at,
        bot_event: { kind: 'request', request_id: 'brq_1', request_kind: 'approval', bot_id: 'bot_a' },
      });
    const persisted = impl.buildTranscript({
      conversationKind: 'group',
      ownerBotId: null,
      messages: [row('2026-10-05T00:00:00.200Z')],
      liveRequests: [request],
    });
    expect(summary(live)).toEqual(['seg:bot_a+h', 'request:brq_1']);
    expect(persisted.find((item) => item.kind === 'request')?.key).toBe(
      live.find((item) => item.kind === 'request')?.key,
    );
    const later = impl.buildTranscript({
      conversationKind: 'direct',
      ownerBotId: 'bot_a',
      messages: [row('2026-10-05T01:00:00.000Z')],
      requests: new Map([[request.id, request]]),
    });
    expect(summary(later)).toEqual(['event']);
  });

  it('picks up queued sends once per interjection turn and finds the speaker', () => {
    const send = (clientId: string, status: 'sending' | 'queued' | 'sent', afterSegment: number) => ({
      clientId,
      content: clientId,
      images: [],
      status,
      afterSegment,
    });
    const pending = [send('a', 'queued', 1), send('b', 'queued', 1), send('c', 'sending', 0)];
    expect(impl.pickUpQueued(pending, [2, 4]).map((item) => item.status)).toEqual(['sent', 'sent', 'sending']);
    expect(impl.pickUpQueued([send('late', 'queued', 3)], [2]).map((item) => item.status)).toEqual(['queued']);
    expect(impl.speakingSegment([segment({ status: 'completed' }), segment({ botId: 'bot_b' })])?.botId).toBe('bot_b');
    expect(impl.stripHandoffPrefix('Sage → @Fern: tighten it')).toBe('tighten it');
  });
});
