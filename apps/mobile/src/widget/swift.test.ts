/**
 * The widget's Swift agrees with the app: targets/widget/DueBuckets.swift is compiled with swiftc
 * and must bucket due dates exactly like src/data/tasks.ts `dueBucket`, also with the phone set to
 * a Buddhist or Japanese calendar, and the widget sources typecheck against the iOS SDK. Skipped
 * where there is no Swift toolchain (Linux CI).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { dueBucket } from '../data/tasks';

const widgetDir = fileURLToPath(new URL('../../targets/widget/', import.meta.url));
const hasSwift = (() => {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const days = ['2026-10-24', '2026-12-28', '2027-02-26', '2028-02-28'];
const dues = (today: string): (string | null)[] => {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const shift = (n: number) => {
    const date = new Date(Date.UTC(y, m - 1, d + n));
    return date.toISOString().slice(0, 10);
  };
  return [
    shift(-30),
    shift(-1),
    today,
    `${today}T23:30:00Z`,
    shift(1),
    shift(6),
    shift(7),
    shift(8),
    shift(40),
    null,
    '',
    'soon',
    '2026-1-5',
  ];
};

describe.skipIf(!hasSwift)('the widget’s Swift', () => {
  const work = mkdtempSync(join(tmpdir(), 'gh-widget-swift-'));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it('buckets due dates like the app, whatever calendar the phone is set to', () => {
    const cases = days.flatMap((today) => dues(today).map((due) => ({ today, due })));
    const swiftString = (value: string | null) => (value === null ? 'nil' : JSON.stringify(value));
    // "today" is an instant: 21:30 on that Gregorian day in the phone's time zone
    const lines = cases.map(({ today, due }) => {
      const [y, m, d] = today.split('-').map(Number);
      return `print(DueBuckets.bucket(due: ${swiftString(due)}, today: day(${y}, ${m}, ${d})))`;
    });
    writeFileSync(
      join(work, 'main.swift'),
      [
        'import Foundation',
        'var gregorian = Calendar(identifier: .gregorian)',
        'gregorian.timeZone = TimeZone.current',
        'func day(_ y: Int, _ m: Int, _ d: Int) -> Date {',
        '  gregorian.date(from: DateComponents(year: y, month: m, day: d, hour: 21, minute: 30))!',
        '}',
        'print(Calendar.current.identifier)',
        ...lines,
      ].join('\n'),
    );
    const binary = join(work, 'buckets');
    execFileSync('xcrun', ['swiftc', '-o', binary, join(widgetDir, 'DueBuckets.swift'), join(work, 'main.swift')], { stdio: 'pipe' });
    const expected = cases.map(({ today, due }) => dueBucket(due, today));
    // the phone's calendar setting (Foundation reads it from the arguments), in a far-east time zone
    for (const [locale, calendar] of [
      ['en_US', 'gregorian'],
      ['th_TH@calendar=buddhist', 'buddhist'],
      ['ja_JP@calendar=japanese', 'japanese'],
    ] as const) {
      const [identifier, ...swift] = execFileSync(binary, ['-AppleLocale', locale], {
        encoding: 'utf8',
        env: { ...process.env, TZ: 'Asia/Shanghai' },
      })
        .trim()
        .split('\n');
      expect(identifier).toBe(calendar);
      expect(swift).toEqual(expected);
    }
    // the table covers every bucket
    expect(new Set(expected)).toEqual(new Set(['overdue', 'today', 'soon', 'later', 'none']));
  }, 120_000);

  it('the widget sources typecheck against the iOS SDK', () => {
    expect(() =>
      execFileSync(
        'xcrun',
        [
          '--sdk',
          'iphonesimulator',
          'swiftc',
          '-typecheck',
          '-target',
          'arm64-apple-ios18.0-simulator',
          join(widgetDir, 'DueBuckets.swift'),
          join(widgetDir, 'index.swift'),
        ],
        { stdio: 'pipe' },
      ),
    ).not.toThrow();
  }, 120_000);
});
