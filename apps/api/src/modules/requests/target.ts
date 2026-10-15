import { and, eq, inArray } from 'drizzle-orm';
import { getDb, mailMessages } from '@greenhouse/db';

/** Stable identities use execution inputs, never translated card text or mutable write values. */
type Payload = Record<string, unknown>;
const object = (value: unknown): Payload =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Payload) : {};
const key = (...parts: unknown[]) => JSON.stringify(parts);

function toolTarget(payload: Payload, mailThreads: ReadonlyMap<string, string> = new Map()): string | null {
  const args = object(payload.input);
  const tool = payload.tool;
  if (typeof tool !== 'string') return null;
  switch (tool) {
    case 'knowledge_mutation':
      return args.doc_id ? key('doc', args.doc_id) : key('folder', args.folder_id ?? args.space ?? 'personal');
    case 'table_mutation': {
      if (!args.table_id) return null;
      const targets = args.record_id
        ? [args.record_id]
        : Array.isArray(args.items)
          ? args.items.map((item) => object(item).id ?? 'table')
          : ['table'];
      return key('table', args.table_id, [...new Set(targets)].sort());
    }
    case 'table_schema_plan':
      return args.base_id || args.name ? key('schema', args.base_id ?? args.name) : null;
    case 'apps_action':
      return args.app_id && args.card ? key('app', args.app_id, args.card, args.record_id ?? null) : null;
    case 'mcp_call': {
      const target = toolTarget({ tool: String(args.tool ?? ''), input: args.arguments });
      return target ? key('connector', args.connector, args.tool, target) : null;
    }
    case 'mail':
      return args.id
        ? key('mail', mailThreads.get(String(args.id)) ?? args.id)
        : args.to
          ? key('mail_draft', args.to, args.subject ?? '')
          : null;
    default: {
      // Connector/browser tools need their tool identity as well as the addressed object.
      const target =
        args.target_id ??
        args.doc_id ??
        args.folder_id ??
        args.record_id ??
        args.table_id ??
        args.base_id ??
        args.schedule_id ??
        args.agent_id ??
        args.id ??
        args.url ??
        args.target;
      return target === undefined ? null : key(tool, target, args.connector_id ?? null);
    }
  }
}

/** Null means the subject has no reliable target: never replace a request by guessing. */
export function requestTargetKey(
  subject: string,
  payload: Payload,
  mailThreads: ReadonlyMap<string, string> = new Map(),
): string | null {
  switch (subject) {
    case 'tool_write': {
      const calls = Array.isArray(payload.calls) ? payload.calls.map(object) : [payload];
      const targets = calls.map((call) => toolTarget(call, mailThreads));
      return targets.some((target) => target === null) ? null : key(...[...new Set(targets)].sort());
    }
    case 'ask_user': {
      const fields = Array.isArray(payload.fields) ? payload.fields.map((field) => object(field).key).sort() : [];
      return key('question', payload.question_key ?? (fields.length ? fields : payload.question));
    }
    case 'instructions_update':
      return key('agent');
    case 'computer_takeover':
      return key('computer');
    case 'vault_fill':
      return key('login', payload.item_id, payload.site);
    case 'run_start':
      return key('run', payload.run_title);
    case 'skill_save': {
      const skill = object(payload.skill);
      return skill.id || skill.name ? key('skill', skill.id ?? skill.name) : null;
    }
    default:
      return toolTarget(payload);
  }
}

/** Resolve stored mail threading in the same permission scope; never alter execution inputs. */
export async function resolveRequestTargetKey(
  subject: string,
  payload: Payload,
  memberId: string,
  agentId?: string | null,
) {
  const calls = Array.isArray(payload.calls) ? payload.calls.map(object) : [payload];
  const ids = calls
    .filter((call) => call.tool === 'mail')
    .flatMap((call) => {
      const id = object(call.input).id;
      return typeof id === 'string' ? [id] : [];
    });
  const rows =
    ids.length && agentId
      ? await getDb()
          .select()
          .from(mailMessages)
          .where(
            and(inArray(mailMessages.id, ids), eq(mailMessages.ownerId, memberId), eq(mailMessages.agentId, agentId)),
          )
      : [];
  return requestTargetKey(
    subject,
    payload,
    new Map(rows.map((row) => [row.id, row.references[0] ?? row.inReplyTo ?? row.messageId ?? row.id])),
  );
}
