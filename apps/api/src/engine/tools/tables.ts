import { z } from 'zod';
import type { TablesService } from '../../modules/tables/service.js';
import { defineTool } from './define.js';
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
  z.object({ action: z.literal('delete'), table_id: z.string().max(64), record_id: z.string().max(64) }),
  z.object({ action: z.literal('bulk'), table_id: z.string().max(64), items: z.array(item).min(1).max(20) }),
]);

export function tableTools(tables: TablesService) {
  const query = defineTool({
    name: 'table_query',
    description:
      'Read a data table or record with the member’s permissions. Supply field ids as keys when writing records.',
    input: z.discriminatedUnion('action', [
      z.object({
        action: z.literal('list'),
        table_id: z.string().max(64),
        limit: z.number().int().min(1).max(50).default(20),
        cursor: z.string().optional(),
      }),
      z.object({ action: z.literal('read'), record_id: z.string().max(64) }),
    ]),
    risk: 'read',
    idempotent: true,
    private: true,
    taints: true,
    available: (ctx) => ctx.modules.tables,
    execute: (args, ctx) =>
      args.action === 'read'
        ? tables.records.get(ctx.memberId, args.record_id)
        : tables.records.query(ctx.memberId, args.table_id, { limit: args.limit, cursor: args.cursor }),
  });
  const mutation = defineTool({
    name: 'table_mutation',
    description:
      'Create, update, recycle or bulk edit records. Private writes run immediately with undo; shared changes require approval unless the member granted this exact table and action. A bulk change is one approval card.',
    input,
    risk: 'write',
    surfaces: ['turn', 'background'],
    guard: (args, ctx) => tables.lockWriteScope(ctx.memberId, args.table_id),
    available: (ctx) => ctx.modules.tables,
    async callRisk(args, ctx) {
      const scope = await tables.writeScope(ctx.memberId, args.table_id);
      if ('record_id' in args) {
        const { record } = await tables.records.get(ctx.memberId, args.record_id);
        if (record.table_id !== args.table_id) throw new Error('This record is in another table.');
      }
      return scope.tier;
    },
    async approvalScope(args) {
      return { type: 'table' as const, id: args.table_id, actions: [`table.${args.action}`] };
    },
    describe: (args, ctx) => ({
      summary: ctx.locale === 'zh' ? '修改表格记录' : 'change table records',
      details: [
        { label: ctx.locale === 'zh' ? '数据表' : 'Data table', value: args.table_id },
        { label: ctx.locale === 'zh' ? '改动' : 'Changes', value: JSON.stringify(args).slice(0, 1200) },
      ],
    }),
    async before(args, ctx) {
      const ids =
        'record_id' in args
          ? [args.record_id]
          : args.action === 'bulk'
            ? args.items.flatMap((entry) => entry.id ?? [])
            : [];
      const records = await Promise.all(
        ids.map(async (id) => {
          const record = (await tables.records.get(ctx.memberId, id)).record;
          const keys =
            args.action === 'update'
              ? Object.keys(args.values)
              : args.action === 'bulk'
                ? Object.keys(args.items.find((entry) => entry.id === id)?.values ?? {})
                : [];
          return { ...record, values: Object.fromEntries(keys.map((key) => [key, record.values[key] ?? null])) };
        }),
      );
      return {
        input: {
          action: args.action,
          table_id: args.table_id,
          ...('record_id' in args ? { record_id: args.record_id } : {}),
        },
        records,
      };
    },
    async execute(args, ctx) {
      switch (args.action) {
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
      const previous = (before as { records: Array<{ id: string; revision: number; values: Record<string, unknown> }> })
        .records;
      if (args.action === 'delete') {
        await tables.undoDeletedRecord(ctx.memberId, args.record_id, previous[0]!.revision + 1);
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
        if (current.record.revision !== record.revision)
          throw conflict('undo_conflict', 'This record changed after the write.');
        if (old) await tables.records.update(ctx.memberId, old.id, record.revision, old.values);
        else await tables.records.remove(ctx.memberId, record.id);
      }
    },
    undoResult(output) {
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
    summarize: (_args, _output, locale) => (locale === 'zh' ? '修改了表格记录' : 'Changed table records'),
  });
  return [query, mutation];
}
