import { z } from 'zod';
import { cardSchema, recordsQuerySchema } from '@greenhouse/contract';
import { comments, getDb, runs } from '@greenhouse/db';
import { eq } from 'drizzle-orm';
import { invalidInput } from '../../http/errors.js';
import { tableSchemaTool } from './tables-schema.js';
import type { TablesService } from '../../modules/tables/service.js';
import { defineTool, type ToolDef } from './define.js';
import { detailText } from './presentation.js';
import { conflict } from '../../http/errors.js';

const values = z.record(z.string(), z.unknown());
const item = z.object({ id: z.string().max(64).optional(), revision: z.number().int().positive().optional(), values });
const input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), table_id: z.string().max(64), values }),
  z.object({
    action: z.literal('update'),
    table_id: z.string().max(64),
    record_id: z.string().max(64),
    revision: z.number().int().positive(),
    values,
  }),
  z.object({
    action: z.literal('comment'),
    table_id: z.string().max(64),
    record_id: z.string().max(64),
    body: z.string().min(1).max(20000),
  }),
  z.object({ action: z.literal('purge'), table_id: z.string().max(64), record_id: z.string().max(64) }),
  z.object({ action: z.literal('delete'), table_id: z.string().max(64), record_id: z.string().max(64) }),
  z.object({ action: z.literal('bulk'), table_id: z.string().max(64), items: z.array(item).min(1).max(20) }),
]);

export function tableTools(tables: TablesService): ToolDef[] {
  const titles = new WeakMap<object, string[]>();
  const verbs = (action: string, zh: boolean) =>
    ({
      create: zh ? '新增' : 'Added',
      bulk: zh ? '批量写入' : 'Wrote',
      update: zh ? '修改' : 'Updated',
      delete: zh ? '删除' : 'Deleted',
      purge: zh ? '永久删除' : 'Permanently deleted',
      comment: zh ? '评论' : 'Commented on',
    })[action] ?? (zh ? '修改' : 'Updated');
  const query = defineTool({
    name: 'table_query',
    description:
      'Discover bases (bases), their tables/fields (tables) and views (views); list filtered/sorted records, read a record, or aggregate a card. Acts with the member’s custom row/column roles. Use returned field ids for writes.',
    input: z.discriminatedUnion('action', [
      z.object({
        action: z.literal('bases'),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      z.object({ action: z.enum(['tables', 'views']), base_id: z.string().max(64) }),
      recordsQuerySchema.extend({
        action: z.literal('list'),
        table_id: z.string().max(64),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      z.object({ action: z.literal('aggregate'), card: cardSchema }),
      z.object({ action: z.literal('read'), record_id: z.string().max(64) }),
    ]),
    summarize: (_args, _output, locale) => (locale === 'zh' ? '查看了表格' : 'Viewed tables'),
    risk: 'read',
    idempotent: true,
    private: true,
    taints: true,
    available: (ctx) => ctx.modules.tables,
    async execute(args, ctx) {
      const [run] = await getDb().select({ input: runs.input }).from(runs).where(eq(runs.id, ctx.runId));
      const baseOnly = run?.input.table_base_id as string | undefined;
      if (baseOnly) {
        if (args.action === 'bases') return { items: [await tables.get(ctx.memberId, baseOnly)], next_cursor: null };
        const baseId =
          'base_id' in args
            ? args.base_id
            : args.action === 'read'
              ? (await tables.records.get(ctx.memberId, args.record_id)).base_id
              : (
                  await tables.scopeLabel(
                    ctx.memberId,
                    args.action === 'aggregate' ? args.card.table_id : args.table_id,
                  )
                ).base_id;
        if (baseId !== baseOnly) throw invalidInput('This run reads only its source base.');
      }
      if (args.action === 'bases') return tables.list(ctx.memberId, { archived: false, ...args });
      if ('base_id' in args) {
        const base = await tables.get(ctx.memberId, args.base_id);
        return { items: args.action === 'tables' ? base.tables : base.views };
      }
      if (args.action === 'aggregate') return tables.cards.query(ctx.memberId, args.card);
      const result =
        args.action === 'read'
          ? await tables.records.get(ctx.memberId, args.record_id)
          : await tables.records.query(ctx.memberId, args.table_id, args);
      const records = 'record' in result ? [result.record] : result.items;
      for (const record of records) {
        const at = await tables.scopeLabel(ctx.memberId, record.table_id);
        ctx.cite?.(
          {
            kind: 'record',
            id: record.id,
            title: String(record.values[at.primary_id ?? ''] ?? at.name),
            url: `${at.href}?record=${record.id}`,
          },
          'read',
        );
      }
      return result;
    },
  });
  const mutation = defineTool({
    name: 'table_mutation',
    description:
      'Create, update, recycle or bulk edit records. Private writes run immediately with undo; shared changes require approval unless the member granted this exact table and action. A bulk change is one approval card.',
    input,
    risk: 'write',
    surfaces: ['turn', 'background'],
    guard: (args, ctx) => tables.lockWriteScope(ctx.memberId, args.table_id, args.action === 'comment'),
    available: (ctx) => ctx.modules.tables,
    async callRisk(args, ctx) {
      const scope = await tables.writeScope(ctx.memberId, args.table_id, args.action === 'comment');
      if (args.action === 'purge') {
        if ((await tables.purgeScope(ctx.memberId, args.record_id)).table_id !== args.table_id)
          throw invalidInput('This record is in another table.');
        return 'tier3';
      }
      if ('record_id' in args) {
        const { record } = await tables.records.get(ctx.memberId, args.record_id);
        if (record.table_id !== args.table_id) throw invalidInput('This record is in another table.');
      }
      return scope.tier;
    },
    async approvalScope(args) {
      return { type: 'table' as const, id: args.table_id, actions: [`table.${args.action}`] };
    },
    async describe(args, ctx) {
      const zh = ctx.locale === 'zh';
      const at = await tables.scopeLabel(ctx.memberId, args.table_id);
      const base = await tables.get(ctx.memberId, at.base_id);
      const table = base.tables.find((table) => table.id === args.table_id)!;
      const details = [{ label: zh ? '数据表' : 'Data table', value: `${base.name} / ${at.name}` }];
      const records = args.action === 'bulk' ? args.items : 'values' in args ? [{ values: args.values }] : [];
      for (const [index, record] of records.entries()) {
        if (records.length > 1) details.push({ label: zh ? '记录' : 'Record', value: String(index + 1) });
        for (const [id, value] of Object.entries(record.values)) {
          const field = table.fields.find((field) => field.id === id);
          if (!field) throw invalidInput('A field is not available in this table.');
          const option = (id: unknown) => field.config.options?.find((option) => option.id === id)?.label ?? id;
          const shown =
            field.type === 'single_select'
              ? option(value)
              : field.type === 'multi_select' && Array.isArray(value)
                ? value.map(option)
                : value;
          details.push({ label: field.name, value: detailText(shown, ctx.locale) });
        }
      }
      if ('record_id' in args) details.push({ label: zh ? '记录' : 'Record', value: args.record_id });
      if (args.action === 'comment') details.push({ label: zh ? '评论' : 'Comment', value: args.body });
      return {
        summary:
          ctx.conversation?.kind === 'room'
            ? `${verbs(args.action, zh)}${zh ? '表格记录' : ' records'}`
            : `${verbs(args.action, zh)}${zh ? '表格' : ' records in'}「${at.name}」${zh ? '的记录' : ''}`,
        details,
      };
    },
    async receipt(args, output, ctx) {
      const zh = ctx.locale === 'zh';
      const at = await tables.scopeLabel(ctx.memberId, args.table_id);
      const result = output as {
        record?: { values: Record<string, unknown> };
        items?: Array<{ ok: boolean; record?: { values: Record<string, unknown> } }>;
      };
      const records = result.record
        ? [result.record]
        : (result.items?.flatMap((item) => (item.ok && item.record ? [item.record] : [])) ?? []);
      if (result.items && !records.length) return zh ? '没有记录写入' : 'No records were written';
      const names = records.map((record) =>
        String(record.values[at.primary_id ?? ''] ?? (zh ? '未命名记录' : 'Untitled record')),
      );
      const before = titles.get(args) ?? [];
      const room = ctx.conversation?.kind === 'room';
      const successful =
        args.action === 'bulk'
          ? (result.items?.flatMap((item, index) => (item.ok && item.record ? [args.items[index]!] : [])) ?? [])
          : [];
      const lines = (names.length ? names : before.length ? before : ['']).map((name, index) => {
        const action = args.action === 'bulk' ? (successful[index]?.id ? 'update' : 'create') : args.action;
        return `${verbs(action, zh)}${zh ? '记录' : ' record'}${!room && name ? `「${name}」` : ''}`;
      });
      return `${room ? '' : `${zh ? '数据表' : 'Table'}「${at.name}」\n`}${lines.join('\n')}`;
    },
    async before(args, ctx) {
      if (args.action === 'purge') return null;
      const ids =
        'record_id' in args
          ? [args.record_id]
          : args.action === 'bulk'
            ? args.items.flatMap((entry) => entry.id ?? [])
            : [];
      const at = await tables.scopeLabel(ctx.memberId, args.table_id);
      const names: string[] = [];
      const records = await Promise.all(
        ids.map(async (id) => {
          const record = (await tables.records.get(ctx.memberId, id)).record;
          names.push(String(record.values[at.primary_id ?? ''] ?? ''));
          const keys =
            args.action === 'update'
              ? Object.keys(args.values)
              : args.action === 'bulk'
                ? Object.keys(args.items.find((entry) => entry.id === id)?.values ?? {})
                : [];
          return { ...record, values: Object.fromEntries(keys.map((key) => [key, record.values[key] ?? null])) };
        }),
      );
      titles.set(args, names);
      return {
        input: {
          action: args.action,
          table_id: args.table_id,
          ...(args.action === 'comment' ? { body: args.body } : {}),
          ...('record_id' in args ? { record_id: args.record_id } : {}),
        },
        records,
      };
    },
    async execute(args, ctx) {
      switch (args.action) {
        case 'comment': {
          const comment = await tables.records.addComment(ctx.memberId, args.record_id, args.body);
          return { commented: comment.id, updated_at: comment.updated_at };
        }
        case 'purge':
          await tables.records.purge(ctx.memberId, args.record_id);
          return { purged: args.record_id };
        case 'create':
          return tables.records.create(ctx.memberId, args.table_id, args.values);
        case 'update':
          return tables.records.update(ctx.memberId, args.record_id, args.revision, args.values);
        case 'delete':
          await tables.records.remove(ctx.memberId, args.record_id);
          return { deleted: args.record_id };
        case 'bulk':
          return tables.records.bulk(ctx.memberId, args.table_id, { items: args.items });
      }
    },
    async undo(args, output, before, ctx) {
      if (args.action === 'purge') throw invalidInput('Permanent deletion cannot be undone.');
      if (args.action === 'comment') {
        const id = (output as { commented: string }).commented;
        const [row] = await getDb().select().from(comments).where(eq(comments.id, id)).for('update');
        if (
          !row ||
          row.body !== args.body ||
          row.updatedAt !== (output as { updated_at: string }).updated_at ||
          row.deletedAt
        )
          throw conflict('undo_conflict', 'This comment changed after the write.');
        await tables.records.removeComment(ctx.memberId, args.record_id, id);
        return;
      }
      const previous = (before as { records: Array<{ id: string; revision: number; values: Record<string, unknown> }> })
        .records;
      const expected = (id: string, revision: number) => {
        const prior = ctx.undoRevisions?.get(id);
        if (!prior) return revision;
        if (prior.written !== revision) throw conflict('undo_conflict', 'This record changed between the writes.');
        return prior.current;
      };
      if (args.action === 'delete') {
        const restored = await tables.undoDeletedRecord(
          ctx.memberId,
          args.record_id,
          expected(args.record_id, previous[0]!.revision + 1),
        );
        ctx.undoRevisions?.set(args.record_id, { written: previous[0]!.revision, current: restored.revision });
        return;
      }
      const result = output as {
        record?: { id: string; revision: number };
        items?: Array<{ ok: boolean; record?: { id: string; revision: number } }>;
      };
      const saved = result.record
        ? [result.record]
        : (result.items?.flatMap((entry) => (entry.ok && entry.record ? [entry.record] : [])) ?? []);
      for (const record of saved) {
        await tables.lockRecord(ctx.memberId, record.id);
        const old = previous.find((entry) => entry.id === record.id);
        const current = await tables.records.get(ctx.memberId, record.id);
        if (current.record.revision !== expected(record.id, record.revision))
          throw conflict('undo_conflict', 'This record changed after the write.');
        if (old) {
          const restored = await tables.records.update(ctx.memberId, old.id, current.record.revision, old.values);
          ctx.undoRevisions?.set(old.id, { written: old.revision, current: restored.record.revision });
        } else {
          await tables.records.remove(ctx.memberId, record.id);
          ctx.undoRevisions?.set(record.id, { written: 0, current: current.record.revision + 1 });
        }
      }
    },
    undoResult(output) {
      if (output && typeof output === 'object' && 'commented' in output) return output;
      const result = output as {
        deleted?: string;
        record?: { id: string; revision: number };
        items?: Array<{ ok: boolean; record?: { id: string; revision: number } }>;
      };
      const minimal = (record: { id: string; revision: number }) => ({ id: record.id, revision: record.revision });
      return {
        ...('deleted' in result ? { deleted: result.deleted } : {}),
        ...(result.record ? { record: minimal(result.record) } : {}),
        ...(result.items
          ? {
              items: result.items.map((entry) => ({
                ok: entry.ok,
                ...(entry.record ? { record: minimal(entry.record) } : {}),
              })),
            }
          : {}),
      };
    },
    summarize: (args, _output, locale) =>
      `${verbs(args.action, locale === 'zh')}${locale === 'zh' ? '了表格记录' : ' table records'}`,
  });
  return [query, mutation, tableSchemaTool(tables)];
}
