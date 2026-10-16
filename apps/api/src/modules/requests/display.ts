/** Card copy is a projection: execution inputs and approval scopes keep their exact ids. */
import { eq } from 'drizzle-orm';
import { conversations, getDb, ID_PREFIX, members } from '@greenhouse/db';
import { ApiError } from '../../http/errors.js';
import type { AppsService } from '../apps/service.js';
import type { AgentsService } from '../agents/service.js';
import type { ConnectorsService } from '../connectors/service.js';
import type { FilesService } from '../files/service.js';
import type { KnowledgeService } from '../knowledge/service.js';
import type { MailService } from '../mail/service.js';
import type { TablesService } from '../tables/service.js';
import type { CreateRequest } from './service.js';

const objectIds = () => new RegExp(`\\b(?:${Object.values(ID_PREFIX).join('|')})_[0-9A-HJKMNP-TV-Z]{6,26}\\b`, 'g');
const path = (entries: readonly { name: string }[]) => entries.map((entry) => entry.name).join(' / ');

export function createCardDisplay(deps: {
  knowledge: KnowledgeService;
  tables: TablesService;
  apps: AppsService;
  agents: AgentsService;
  files: FilesService;
  connectors: ConnectorsService;
  mail: MailService;
}) {
  return async (input: CreateRequest): Promise<CreateRequest> => {
    const [member] = await getDb()
      .select({ locale: members.locale })
      .from(members)
      .where(eq(members.id, input.memberId));
    const [conversation] = input.conversationId
      ? await getDb()
          .select({ kind: conversations.kind })
          .from(conversations)
          .where(eq(conversations.id, input.conversationId))
      : [];
    const unavailable = member?.locale === 'en' ? 'Unavailable object' : '不可用的对象';
    const reference = member?.locale === 'en' ? 'referenced object' : '关联对象';
    const clean = (text: string) => text.replace(objectIds(), unavailable);
    const labels = new Map<string, Promise<string>>();
    const as = input.agentId ? { agentId: input.agentId } : undefined;
    const resolve = (id: string): Promise<string> => {
      const saved = labels.get(id);
      if (saved) return saved;
      // Arbitrary connector arguments and model text cannot cause unbounded service reads.
      if (labels.size >= 64) return Promise.resolve(unavailable);
      const value = (async () => {
        try {
          switch (id.slice(0, 3)) {
            case 'fld': {
              const folder = await deps.knowledge.folder(input.memberId, id, as);
              return path([...folder.path, folder]);
            }
            case 'doc': {
              const doc = await deps.knowledge.getDoc(input.memberId, id, { as, signed: false });
              return path([...doc.path, { name: doc.title }]);
            }
            case 'bas':
              return (await deps.tables.get(input.memberId, id)).name;
            case 'tbl': {
              const at = await deps.tables.scopeLabel(input.memberId, id);
              const base = await deps.tables.get(input.memberId, at.base_id);
              return `${base.name} / ${at.name}`;
            }
            case 'col':
              return await deps.tables.fieldLabel(input.memberId, id);
            case 'rec': {
              const { record, base_id } = await deps.tables.records.get(input.memberId, id);
              const base = await deps.tables.get(input.memberId, base_id);
              const table = base.tables.find((table) => table.id === record.table_id);
              const primary = table?.fields.find((field) => field.is_primary);
              const title = primary ? record.values[primary.id] : null;
              return `${base.name} / ${table?.name ?? unavailable}${title ? ` / ${String(title)}` : ''}`;
            }
            case 'app':
              return (await deps.apps.runtime(input.memberId, id)).app.name;
            case 'agt':
              return (await deps.agents.get(input.memberId, id)).name;
            case 'fil':
              return (await deps.files.get(input.memberId, id)).name;
            case 'cnr':
              return (
                (await deps.connectors.mine(input.memberId)).connectors.find((connector) => connector.id === id)
                  ?.name ?? unavailable
              );
            case 'mal':
              return input.agentId ? (await deps.mail.get(input.memberId, input.agentId, id)).subject : unavailable;
            default:
              return unavailable;
          }
        } catch (error) {
          if (error instanceof ApiError && [403, 404].includes(error.status)) return unavailable;
          throw error;
        }
      })().then(clean);
      labels.set(id, value);
      return value;
    };
    const text = async (value: string, shared = false) => {
      const ids = [...new Set(value.match(objectIds()) ?? [])];
      const names = new Map<string, string>();
      for (const id of ids) names.set(id, shared ? reference : await resolve(id));
      return value.replace(objectIds(), (id) => names.get(id) ?? unavailable);
    };
    const project = async (): Promise<CreateRequest> => {
      const payload = { ...input.payload };
      if (typeof payload.summary === 'string')
        payload.summary = await text(payload.summary, conversation?.kind === 'room');
      const details = async (value: unknown): Promise<unknown> => {
        if (typeof value === 'string') return text(value);
        if (Array.isArray(value)) return Promise.all(value.map(details));
        if (value && typeof value === 'object') {
          return Object.fromEntries(
            await Promise.all(Object.entries(value).map(async ([key, item]) => [await text(key), await details(item)])),
          );
        }
        return value;
      };
      if (payload.details !== undefined) payload.details = await details(payload.details);
      const display: Record<string, string> = {};
      for (const key of ['reason', 'brief', 'instructions', 'current', 'run_title']) {
        const value = payload[key];
        if (typeof value !== 'string') continue;
        const projected = await text(value);
        if (projected !== value) display[key] = projected;
      }
      // Proposal text is also execution evidence: project its preview without rewriting it.
      if (Object.keys(display).length) payload.display = display;
      return { ...input, title: await text(input.title, conversation?.kind === 'room'), payload };
    };
    // App action cards must never name columns hidden by their publication's narrower role.
    const args = input.payload.input as { app_id: string; version: number; card: string } | undefined;
    return input.payload.tool === 'apps_action' &&
      typeof args?.app_id === 'string' &&
      typeof args.version === 'number' &&
      typeof args.card === 'string'
      ? deps.apps.inActionScope(input.memberId, args.app_id, args.version, args.card, project)
      : project();
  };
}
