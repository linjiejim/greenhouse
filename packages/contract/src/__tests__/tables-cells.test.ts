import { describe, expect, it } from 'vitest';
import {
  CellParseError,
  csvLine,
  formatCell,
  parseCell,
  parseClipboard,
  parseDay,
  toClipboard,
  zonedDay,
  zonedInstant,
} from '../tables-cells';
import type { Field } from '../tables';

const field = (type: Field['type'], config: Field['config'] = {}): Field => ({
  id: 'col_1',
  table_id: 'tbl_1',
  name: 'F',
  type,
  config,
  required: false,
  is_primary: false,
  position: 0,
});

const status = field('single_select', {
  options: [
    { id: 'todo', label: '待开始', color: 'gray' },
    { id: 'done', label: '已完成', color: 'green' },
  ],
});
const ctx = {
  timeZone: 'Asia/Shanghai',
  memberName: (id: string) => ({ mbr_a: 'Lin', mbr_b: 'Mei' })[id],
  findMember: (text: string) => ({ lin: 'mbr_a', 'mei@example.com': 'mbr_b' })[text.toLowerCase()],
  linkedTitle: (id: string) => ({ rec_a: 'Design' })[id],
  findRecord: (_table: string, title: string) => (title === 'Design' ? 'rec_a' : undefined),
  fileName: (id: string) => ({ fil_a: 'plan.pdf' })[id],
};

describe('formatCell', () => {
  it('shows options by label, people by name, links by title and files by name', () => {
    expect(formatCell(status, 'done', ctx)).toBe('已完成');
    expect(formatCell(field('multi_select', status.config), ['todo', 'done'], ctx)).toBe('待开始, 已完成');
    expect(formatCell(field('member'), ['mbr_a', 'mbr_b'], ctx)).toBe('Lin, Mei');
    expect(formatCell(field('dependency'), ['rec_a'], ctx)).toBe('Design');
    expect(formatCell(field('attachment'), ['fil_a'], ctx)).toBe('plan.pdf');
    expect(formatCell(field('number', { precision: 2 }), 3.5, ctx)).toBe('3.50');
    expect(formatCell(field('checkbox'), true, ctx)).toBe('true');
    expect(formatCell(field('checkbox'), undefined, ctx)).toBe('false');
    expect(formatCell(field('text'), null, ctx)).toBe('');
  });

  it('shows a date-time in the reader’s time zone', () => {
    expect(formatCell(field('datetime'), '2026-10-16T01:30:00.000Z', ctx)).toBe('2026-10-16 09:30');
  });
});

describe('parseCell', () => {
  it('reads pasted text into each kind of value, and clears on empty', () => {
    expect(parseCell(field('number'), '1,234.5', ctx)).toBe(1234.5);
    expect(parseCell(field('number'), '12%', ctx)).toBe(0.12);
    expect(parseCell(field('date'), '2026/10/16', ctx)).toBe('2026-10-16');
    expect(parseCell(field('date'), '2026年10月6日', ctx)).toBe('2026-10-06');
    expect(parseCell(field('datetime'), '2026-10-16 09:30', ctx)).toBe('2026-10-16T01:30:00.000Z');
    expect(parseCell(status, '已完成', ctx)).toBe('done');
    expect(parseCell(field('multi_select', status.config), '待开始，已完成', ctx)).toEqual(['todo', 'done']);
    expect(parseCell(field('member', { multiple: true }), 'Lin, mei@example.com', ctx)).toEqual(['mbr_a', 'mbr_b']);
    expect(parseCell(field('member'), 'Lin, mei@example.com', ctx)).toEqual(['mbr_a']);
    expect(parseCell(field('parent'), 'Design', ctx)).toEqual(['rec_a']);
    expect(parseCell(field('checkbox'), '是', ctx)).toBe(true);
    expect(parseCell(field('checkbox'), '', ctx)).toBe(false);
    expect(parseCell(field('text'), '', ctx)).toBeNull();
  });

  it('refuses what a field cannot hold', () => {
    expect(() => parseCell(field('number'), 'many', ctx)).toThrow(CellParseError);
    expect(() => parseCell(field('date'), '2026-02-30', ctx)).toThrow(CellParseError);
    expect(() => parseCell(status, 'Maybe', ctx)).toThrow(CellParseError);
    expect(() => parseCell(field('member'), 'Nobody', ctx)).toThrow(CellParseError);
    expect(() => parseCell(field('attachment'), 'file.pdf', ctx)).toThrow(CellParseError);
  });
});

describe('days and zones', () => {
  it('turns wall-clock times into instants and back', () => {
    expect(zonedInstant('2026-10-16', '00:00', 'Asia/Shanghai')).toBe('2026-10-15T16:00:00.000Z');
    expect(zonedDay('2026-10-15T16:00:00.000Z', 'Asia/Shanghai')).toBe('2026-10-16');
    expect(zonedInstant('2026-03-08', '12:00', 'America/New_York')).toBe('2026-03-08T16:00:00.000Z');
    expect(parseDay('2026-1-5')).toBe('2026-01-05');
    expect(parseDay('16/10/2026')).toBeNull();
  });
});

describe('clipboard and CSV', () => {
  it('reads tab-separated rows with quoted cells and writes them back', () => {
    const text = 'a\tb\n"line\none"\t"say ""hi"""\n';
    expect(parseClipboard(text)).toEqual([
      ['a', 'b'],
      ['line\none', 'say "hi"'],
    ]);
    expect(parseClipboard(toClipboard([['x\ty', 'z']]))).toEqual([['x\ty', 'z']]);
    expect(csvLine(['a,b', 'c"d', 'e'])).toBe('"a,b","c""d",e');
  });

  it('keeps text a spreadsheet would run as a formula as text, and numbers as they are', () => {
    expect(csvLine(['=SUM(A1)', '+1', '-2', '@cmd', '\tx', 'ok', '1-2'])).toBe("'=SUM(A1),'+1,'-2,'@cmd,'\tx,ok,1-2");
    expect(csvLine([{ number: '-5' }, { number: '3.50' }, '-5'])).toBe("-5,3.50,'-5");
    expect(csvLine(['=HYPERLINK("x","y")'])).toBe('"\'=HYPERLINK(""x"",""y"")"');
  });
});

describe('computed cells', () => {
  it('show what a formula, lookup, rollup or AI field yields, and failures as # and their reason', () => {
    expect(formatCell(field('formula', { result: 'number', precision: 1 }), 2.25, ctx)).toBe('2.3');
    expect(formatCell(field('formula', { result: 'checkbox' }), true, ctx)).toBe('true');
    expect(formatCell(field('formula', { result: 'datetime' }), '2026-10-16T01:30:00.000Z', ctx)).toBe(
      '2026-10-16 09:30',
    );
    expect(formatCell(field('rollup', { result: 'number' }), 12, ctx)).toBe('12');
    expect(formatCell(field('lookup'), ['a', 2, true], ctx)).toBe('a, 2, true');
    expect(formatCell(field('ai'), 'A note', ctx)).toBe('A note');
    expect(formatCell(field('formula'), { error: 'div_zero' }, ctx)).toBe('#div_zero');
    expect(formatCell(field('ai'), { pending: true }, ctx)).toBe('');
  });

  it('cannot be pasted into', () => {
    expect(() => parseCell(field('formula'), '3', ctx)).toThrow(CellParseError);
  });
});
