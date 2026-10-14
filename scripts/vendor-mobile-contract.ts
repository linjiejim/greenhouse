/**
 * Writes apps/mobile/src/shared/contract.ts: the API v2 types and constants the mobile app uses,
 * spelled out as plain TypeScript from packages/contract. apps/mobile sits outside the workspace
 * and carries no zod, so it cannot import the schemas; it gets what they infer instead.
 * apps/mobile/src/shared/contract.parity.test.ts (root vitest) fails when the copy is stale.
 *
 *   node --import tsx scripts/vendor-mobile-contract.ts
 *
 * Add a name to TYPES or CONSTANTS when the app needs another one, then run it again.
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as prettier from 'prettier';
import ts from 'typescript';
import * as contract from '../packages/contract/src/index.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = resolve(ROOT, 'packages/contract/src/index.ts');
export const TARGET = resolve(ROOT, 'apps/mobile/src/shared/contract.ts');

/** Types the app uses, each written out in full. */
export const TYPES = [
  'ApiErrorBody',
  'Bootstrap',
  'TokenPair',
  'LinkInfo',
  'MemberModules',
  'MemberSummary',
  'Me',
  'UpdateMeInput',
  'AgentAvatar',
  'Agent',
  'AgentDetail',
  'PublicAgent',
  'AgentMemory',
  'CreateAgentInput',
  'UpdateAgentInput',
  'Conversation',
  'ConversationDetail',
  'ConversationMembers',
  'CreateConversationInput',
  'UpdateConversationInput',
  'Message',
  'MessageItem',
  'SendMessageInput',
  'SendMessageResult',
  'EditMessageResult',
  'RegenerateResult',
  'FeedbackInput',
  'Feedback',
  'RealtimeEvent',
  'QuestionField',
  'NeedsYou',
  'Notification',
  'NotificationSettings',
  'UpdateNotificationSettingsInput',
  'PushPrefs',
  'PushDevice',
  'PushDeviceList',
  'PushDeviceRegistered',
  'RegisterPushDeviceInput',
  'RunView',
  'RunDetail',
  'FileView',
  'ComputerView',
  'ComputerJob',
  'ComputerTicket',
  'ComputerTicketPurpose',
  'ComputerFile',
  'ComputerFolder',
  'SkillVariable',
  'Skill',
  'SkillStarters',
  'Schedule',
  'CreateScheduleInput',
  'UpdateScheduleInput',
  'StandingApproval',
  'AppSummary',
  'AppRuntime',
  'AppCard',
  'AppAction',
  'AppCardAnswer',
  'CardData',
  'KnowledgeScope',
  'KnowledgeItem',
  'KnowledgeFolder',
  'KnowledgeDoc',
  'KnowledgeFile',
  'KnowledgeSearchHit',
  'KnowledgeComment',
  'KnowledgeShares',
  'DocVersion',
  'DocVersionDetail',
  'DocPresence',
  'View',
  'Base',
  'BaseSummary',
  'BaseTable',
  'Field',
  'TableRecord',
  'RecordPage',
  'RecordDetail',
  'RecordActivity',
  'Form',
  'FormFill',
  'FormFillField',
  'Mailbox',
  'MailItem',
  'MailDetail',
] as const;

/** Values the app uses, copied as literals. */
export const CONSTANTS = [
  'API_VERSION',
  'REALTIME_SIGN_IN_AGAIN',
  'COMPUTER_SOCKET_CLOSE',
  'CONVERSATION_KINDS',
  'MESSAGE_MAX',
  'FEEDBACK_COMMENT_MAX',
  'AGENT_NAME_MAX',
  'AGENT_ROLE_MAX',
  'AGENT_DESCRIPTION_MAX',
  'AGENT_INSTRUCTIONS_MAX',
  'MAX_AGENTS',
  'MAX_VIEW_RECORDS',
  'COMPUTED_FIELD_TYPES',
  'THEMES',
  'REQUEST_KINDS',
  'RUN_STATUSES',
  'RUN_SOURCES',
  'COMPUTER_STATES',
  'NOTIFICATION_CATEGORIES',
  'DELIVERY_CHANNELS',
  'PUSH_PLATFORMS',
  'EXPO_PUSH_TOKEN',
] as const;

const HEADER = `/**
 * GENERATED from packages/contract by scripts/vendor-mobile-contract.ts: the API v2 types and
 * constants the app uses, written out because apps/mobile cannot import @greenhouse/contract or
 * zod. Never edit this file: add names to the script and run
 * \`node --import tsx scripts/vendor-mobile-contract.ts\` from the repo root.
 * contract.parity.test.ts (root vitest) fails when it is stale.
 */

/** A page of a list: \`{ items, next_cursor }\` (cursor pagination). */
export type Page<T> = { items: T[]; next_cursor: string | null };
`;

function literal(value: unknown): string {
  if (value instanceof RegExp) return String(value);
  return `${JSON.stringify(value)} as const`;
}

/** The generated module's text, formatted like the repo. */
export async function render(): Promise<string> {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  };
  const program = ts.createProgram([ENTRY], options);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(ENTRY);
  const module = source && checker.getSymbolAtLocation(source);
  if (!module) throw new Error(`Cannot read ${ENTRY}`);
  const exports = new Map(checker.getExportsOfModule(module).map((symbol) => [symbol.name, symbol]));

  const flags =
    ts.TypeFormatFlags.NoTruncation |
    ts.TypeFormatFlags.InTypeAlias |
    ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType |
    ts.TypeFormatFlags.WriteArrayAsGenericType;

  const blocks: string[] = [HEADER];
  for (const name of TYPES) {
    let symbol = exports.get(name);
    if (!symbol) throw new Error(`packages/contract exports no type ${name}`);
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const type = checker.getDeclaredTypeOfSymbol(symbol);
    let text = checker.typeToString(type, undefined, flags);
    // Interfaces keep their own name even with InTypeAlias; emit their properties instead.
    if (text === name) {
      text = `{ ${checker
        .getPropertiesOfType(type)
        .map((property) => {
          const at = property.valueDeclaration ?? property.declarations?.[0] ?? source!;
          const value = checker.typeToString(checker.getTypeOfSymbolAtLocation(property, at), undefined, flags);
          return `${JSON.stringify(property.name)}${property.flags & ts.SymbolFlags.Optional ? '?' : ''}: ${value};`;
        })
        .join(' ')} }`;
    }
    if (/\bz\.|Zod/.test(text)) throw new Error(`${name} still names zod: ${text.slice(0, 200)}`);
    blocks.push(`export type ${name} = ${text};`);
  }
  const values = contract as unknown as Record<string, unknown>;
  for (const name of CONSTANTS) {
    if (!(name in values)) throw new Error(`packages/contract exports no constant ${name}`);
    blocks.push(`export const ${name} = ${literal(values[name])};`);
  }
  const config = (await prettier.resolveConfig(TARGET)) ?? {};
  return prettier.format(blocks.join('\n\n'), { ...config, parser: 'typescript', filepath: TARGET });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(TARGET, await render());
  console.log(`wrote ${TARGET}`);
}
