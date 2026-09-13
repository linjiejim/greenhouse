import type { TableFieldConfig, TableRecordValues } from '@greenhouse/types/tables';
import type { TableBatchRecordItem, TableField, TableRecord } from '../../lib/api/tables';
import { safeParse } from '../../lib/utils';

export interface TablePasteUser {
  id: string;
  nickname: string;
  email: string;
}

export function parseClipboardMatrix(text: string): string[][] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const rows = normalized.split('\n');
  if (rows.at(-1) === '') rows.pop();
  return rows.map((row) => row.split('\t'));
}

function splitList(raw: string): string[] {
  return raw
    .split(/[,;\n]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function findUser(raw: string, users: TablePasteUser[]): string {
  const needle = raw.trim().toLocaleLowerCase();
  const user = users.find(
    (candidate) =>
      candidate.id.toLocaleLowerCase() === needle ||
      candidate.email.toLocaleLowerCase() === needle ||
      candidate.nickname.toLocaleLowerCase() === needle,
  );
  if (!user) throw new Error(`Unknown user "${raw}"`);
  return user.id;
}

function findOption(raw: string, config: TableFieldConfig): string {
  const needle = raw.trim().toLocaleLowerCase();
  const option = (config.options ?? []).find(
    (candidate) => candidate.id.toLocaleLowerCase() === needle || candidate.label.toLocaleLowerCase() === needle,
  );
  if (!option) throw new Error(`Unknown option "${raw}"`);
  return option.id;
}

export function parsePastedCell(field: TableField, raw: string, users: TablePasteUser[]): unknown {
  const value = raw.trim();
  if (!value) return null;
  const config = safeParse<TableFieldConfig>(field.config, {});

  if (field.type === 'number') {
    const number = Number(value.replace(/,/g, ''));
    if (!Number.isFinite(number)) throw new Error(`"${raw}" is not a number`);
    return number;
  }
  if (field.type === 'boolean') {
    if (/^(true|yes|y|1|是|对)$/i.test(value)) return true;
    if (/^(false|no|n|0|否|错)$/i.test(value)) return false;
    throw new Error(`"${raw}" is not a checkbox value`);
  }
  if (field.type === 'datetime') {
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) throw new Error(`"${raw}" is not a date and time`);
    return date.toISOString();
  }
  if (field.type === 'single_select') return findOption(value, config);
  if (field.type === 'multi_select') return splitList(value).map((entry) => findOption(entry, config));
  if (field.type === 'user') return findUser(value, users);
  if (field.type === 'multi_user') return splitList(value).map((entry) => findUser(entry, users));
  if (field.type === 'attachment') return splitList(value);
  if (field.type === 'relation') {
    const ids = splitList(value).map((entry) => Number(entry.replace(/^#/, '')));
    if (ids.some((id) => !Number.isInteger(id) || id <= 0)) throw new Error(`"${raw}" is not a record id`);
    return config.relation?.multiple ? ids : ids[0];
  }
  if (field.type === 'formula' || field.type === 'rollup') {
    throw new Error(`"${field.name}" is computed and cannot be pasted`);
  }
  return value;
}

export function buildPasteBatch(input: {
  matrix: string[][];
  startRow: number;
  startColumn: number;
  records: TableRecord[];
  fields: TableField[];
  users: TablePasteUser[];
}): TableBatchRecordItem[] {
  return input.matrix.map((row, rowOffset) => {
    const values: TableRecordValues = {};
    row.forEach((raw, columnOffset) => {
      const field = input.fields[input.startColumn + columnOffset];
      if (!field) return;
      values[String(field.id)] = parsePastedCell(field, raw, input.users);
    });
    const record = input.records[input.startRow + rowOffset];
    return record
      ? { record_id: record.id, revision: record.revision, values }
      : {
          values,
        };
  });
}
