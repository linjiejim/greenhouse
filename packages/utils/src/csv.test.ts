import { describe, expect, it } from 'vitest';
import { decodeCsvBytes, parseCsv, sniffCsvDelimiter, unguardCsvCell } from './csv.js';

/** `姓名,城市,备注\n张三,北京,"含,逗号"\n` saved by a Chinese Excel (GBK). */
const GBK_SAMPLE = Uint8Array.from([
  0xd0, 0xd5, 0xc3, 0xfb, 0x2c, 0xb3, 0xc7, 0xca, 0xd0, 0x2c, 0xb1, 0xb8, 0xd7, 0xa2, 0x0a, 0xd5, 0xc5, 0xc8, 0xfd,
  0x2c, 0xb1, 0xb1, 0xbe, 0xa9, 0x2c, 0x22, 0xba, 0xac, 0x2c, 0xb6, 0xba, 0xba, 0xc5, 0x22, 0x0a,
]);

function utf16le(text: string, bom: boolean): Uint8Array {
  const body = Buffer.from(text, 'utf16le');
  return bom ? Uint8Array.from([0xff, 0xfe, ...body]) : Uint8Array.from(body);
}

describe('parseCsv', () => {
  it('reads quoted fields, escaped quotes and delimiters inside quotes', () => {
    const { rows } = parseCsv('name,quote\n"Smith, J","He said ""hi"""\nplain,"x"\n');
    expect(rows).toEqual([
      ['name', 'quote'],
      ['Smith, J', 'He said "hi"'],
      ['plain', 'x'],
    ]);
  });

  it('keeps line breaks inside quotes and accepts CRLF, LF and lone CR endings', () => {
    const { rows } = parseCsv('a,b\r\n"line 1\r\nline 2",x\r\nc,d\re,f\ng,h');
    expect(rows).toEqual([
      ['a', 'b'],
      ['line 1\nline 2', 'x'],
      ['c', 'd'],
      ['e', 'f'],
      ['g', 'h'],
    ]);
  });

  it('keeps empty cells, drops blank lines and never trims or coerces', () => {
    const { rows } = parseCsv('a,,c\n\n , 00123 ,\n""\n');
    expect(rows).toEqual([
      ['a', '', 'c'],
      [' ', ' 00123 ', ''],
    ]);
  });

  it('is lenient with stray quotes and unterminated fields', () => {
    expect(parseCsv('size,note\n5" screen,"abc"def\n').rows).toEqual([
      ['size', 'note'],
      ['5" screen', 'abcdef'],
    ]);
    expect(parseCsv('a,b\n1,"never closed\nstill open').rows).toEqual([
      ['a', 'b'],
      ['1', 'never closed\nstill open'],
    ]);
  });

  it('strips the BOM and every NUL character', () => {
    const { rows } = parseCsv(`\uFEFFa${String.fromCharCode(0)}b,c\n1,2`);
    expect(rows).toEqual([
      ['ab', 'c'],
      ['1', '2'],
    ]);
  });

  it('removes the formula guard our exports add, and only that', () => {
    const { rows } = parseCsv(`"'=SUM(A1)","'-5","'+1","'@me","'quoted","it's"\n`);
    expect(rows).toEqual([['=SUM(A1)', '-5', '+1', '@me', "'quoted", "it's"]]);
    expect(parseCsv(`"'=x"`, { unguardFormulas: false }).rows).toEqual([["'=x"]]);
    expect(unguardCsvCell("'")).toBe("'");
  });

  it('stops at maxRows and reports the truncation', () => {
    const result = parseCsv('h\n1\n2\n3\n', { maxRows: 3 });
    expect(result.rows).toEqual([['h'], ['1'], ['2']]);
    expect(result.truncated).toBe(true);
    expect(parseCsv('h\n1\n2\n', { maxRows: 3 }).truncated).toBe(false);
  });
});

describe('delimiter sniffing', () => {
  it('picks the delimiter that splits records consistently', () => {
    expect(sniffCsvDelimiter('a;b;c\n1;2;3\n4;5;6')).toBe(';');
    expect(sniffCsvDelimiter('a\tb\n1\t2')).toBe('\t');
    // Commas inside quoted text do not outvote the real semicolon delimiter.
    expect(sniffCsvDelimiter('name;note\n"Smith, J";"a, b, c"\nLee;x')).toBe(';');
    expect(sniffCsvDelimiter('just one column\nno delimiters')).toBe(',');
    expect(parseCsv('a;b\n1,5;2').rows).toEqual([
      ['a', 'b'],
      ['1,5', '2'],
    ]);
  });

  it("honours Excel's sep= first line", () => {
    const result = parseCsv('sep=;\r\na;b,c\n1;2,3');
    expect(result.delimiter).toBe(';');
    expect(result.rows).toEqual([
      ['a', 'b,c'],
      ['1', '2,3'],
    ]);
  });
});

describe('decodeCsvBytes', () => {
  it('decodes UTF-8 with and without a BOM', () => {
    const text = '名称,金额\n测试,1';
    expect(decodeCsvBytes(new TextEncoder().encode(text))).toEqual({ text, encoding: 'utf-8' });
    const withBom = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
    expect(decodeCsvBytes(withBom)).toEqual({ text, encoding: 'utf-8' });
  });

  it('falls back to GB18030 for bytes that are not UTF-8 (a GBK export)', () => {
    const decoded = decodeCsvBytes(GBK_SAMPLE);
    expect(decoded.encoding).toBe('gb18030');
    expect(parseCsv(decoded.text).rows).toEqual([
      ['姓名', '城市', '备注'],
      ['张三', '北京', '含,逗号'],
    ]);
  });

  it('decodes UTF-16 by BOM and by the NUL pattern', () => {
    expect(decodeCsvBytes(utf16le('a,b\n1,2', true))).toEqual({ text: 'a,b\n1,2', encoding: 'utf-16le' });
    expect(decodeCsvBytes(utf16le('name,city\nAda,London', false))).toEqual({
      text: 'name,city\nAda,London',
      encoding: 'utf-16le',
    });
    const be = Uint8Array.from([0xfe, 0xff, 0x00, 0x61, 0x00, 0x2c, 0x00, 0x62]);
    expect(decodeCsvBytes(be)).toEqual({ text: 'a,b', encoding: 'utf-16be' });
  });

  it('never returns NUL characters', () => {
    const bytes = new TextEncoder().encode(`name,city\nAda${String.fromCharCode(0)} Lovelace,London\n`);
    expect(decodeCsvBytes(bytes)).toEqual({ text: 'name,city\nAda Lovelace,London\n', encoding: 'utf-8' });
  });
});
