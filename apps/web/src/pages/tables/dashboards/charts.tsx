/**
 * What a card draws: a big figure, bars, a line, a donut with its legend, a list of records.
 * Colours come from the tokens (an option's own colour, else the chart series), and every figure
 * is also written out: bars and the legend in words, the line in a table for screen readers.
 * Charts are drawn at their real size, so their words stay 12px on a small card.
 */

import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { BaseTable, Card, CardData, CardGroup } from '@greenhouse/contract';
import { usePeople } from '../../../data/people';
import { useSession } from '../../../app/session';
import { cx } from '../../../lib/cx';
import { useI18n } from '../../../lib/i18n';
import { href } from '../../../lib/router';
import { CellValue } from '../cells';
import type { CellLookups } from '../model';
import {
  dayLabel,
  formatFigure,
  groupLabel,
  lineRuns,
  niceScale,
  otherLabel,
  pieSlices,
  seriesOf,
  slicePath,
} from './model';

type GroupsData = Extract<CardData, { kind: 'groups' }>;
type ListData = Extract<CardData, { kind: 'list' }>;

/** How a group is coloured: its option's colour, a series colour, or the neutral ones for the rest and the empty. */
type Tone = { option: string } | { series: number } | 'other' | 'empty';
const toneClass = (tone: Tone) =>
  tone === 'other'
    ? 'is-other'
    : tone === 'empty'
      ? 'is-empty'
      : 'option' in tone
        ? `is-${tone.option}`
        : `is-c${tone.series}`;

interface Row {
  key: string;
  label: string;
  value: number | null;
  records: number;
  tone: Tone;
}

/** The groups and the rest, in order, with their words and colours. `series`: one colour per group. */
function rowsOf(data: GroupsData, words: ReturnType<typeof useI18n>, series: boolean): Row[] {
  const { t, locale } = words;
  const rows = data.groups.map(
    (group: CardGroup, index): Row => ({
      key: group.key ?? '\u0000empty',
      label: groupLabel(group, data, locale, t),
      value: group.value,
      records: group.records,
      tone:
        group.key === null ? 'empty' : group.color ? { option: group.color } : { series: series ? seriesOf(index) : 1 },
    }),
  );
  if (data.other) {
    rows.push({ key: '\u0000other', label: otherLabel(data, t), ...data.other, tone: 'other' });
  }
  return rows;
}

/** The width an element has now, kept as it changes. */
function useWidth(ref: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => setWidth(Math.round(entries[0]?.contentRect.width ?? 0)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export function NumberFigure({
  data,
  precision,
  caption,
}: {
  data: Extract<CardData, { kind: 'number' }>;
  precision?: number;
  caption?: string;
}) {
  const { locale } = useI18n();
  return (
    <div className="app-tb-dash-number">
      <p className="app-tb-dash-figure">{formatFigure(data.value, locale, precision)}</p>
      {caption && <p className="app-tb-dash-caption">{caption}</p>}
    </div>
  );
}

/** Horizontal bars, one row per group: its words, the bar, the figure. */
export function BarList({ data, label, precision }: { data: GroupsData; label: string; precision?: number }) {
  const words = useI18n();
  const rows = rowsOf(data, words, false);
  const max = Math.max(0, ...rows.map((row) => row.value ?? 0));
  return (
    <ul className="app-tb-dash-bars" aria-label={label}>
      {rows.map((row) => {
        const share = max > 0 && row.value !== null && row.value > 0 ? (row.value / max) * 100 : 0;
        return (
          <li key={row.key} className="app-tb-dash-bar">
            <span className="app-tb-dash-bar-label" title={row.label}>
              {row.label}
            </span>
            <span className="app-tb-dash-bar-track" aria-hidden>
              <span className={cx('app-tb-dash-bar-fill', toneClass(row.tone))} style={{ width: `${share}%` }} />
            </span>
            <span className="app-tb-dash-bar-value">{formatFigure(row.value, words.locale, precision)}</span>
          </li>
        );
      })}
    </ul>
  );
}

const LINE_HEIGHT = 180;
const PAD = { top: 8, right: 8, bottom: 24 };
/** Room for a word under the axis. */
const LABEL_WIDTH = 72;

/**
 * A line through the groups in order: dates oldest first (the empty dates and the earlier ones
 * written under it), anything else as it comes. A gap where a figure is missing.
 */
export function LineChart({ data, label, precision }: { data: GroupsData; label: string; precision?: number }) {
  const words = useI18n();
  const { t, locale } = words;
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const all = rowsOf(data, words, false);
  const dated = data.key_type === 'date';
  const points = dated ? all.filter((row) => row.tone !== 'empty' && row.tone !== 'other') : all;
  const notes = dated ? all.filter((row) => row.tone === 'empty' || row.tone === 'other') : [];
  const values = points.map((row) => row.value);
  const numbers = values.filter((value): value is number => value !== null);
  const scale = niceScale(Math.min(0, ...numbers), Math.max(0, ...numbers));
  const tickText = scale.ticks.map((tick) => formatFigure(tick, locale));
  const left = 8 + Math.max(...tickText.map((text) => text.length)) * 7;
  const frame = { width, height: LINE_HEIGHT, left, ...PAD };
  const runs = width ? lineRuns(values, frame, scale) : [];
  const inner = LINE_HEIGHT - PAD.top - PAD.bottom;
  const y = (value: number) => PAD.top + inner - ((value - scale.min) / (scale.max - scale.min || 1)) * inner;
  const band = (width - left - PAD.right) / Math.max(1, points.length);
  const every = Math.max(1, Math.ceil((points.length * LABEL_WIDTH) / Math.max(1, width - left)));
  // A week under the axis is its first day; its full words are in the dot's tooltip.
  const axisLabel = (row: Row) => (dated && data.bucket === 'week' ? dayLabel(row.key, locale) : row.label);
  return (
    <div className="app-tb-dash-line">
      <div ref={box} className="app-tb-dash-line-box">
        {width > 0 && (
          <svg width={width} height={LINE_HEIGHT} role="img" aria-label={label}>
            <g className="app-tb-dash-axis" aria-hidden>
              {scale.ticks.map((tick, index) => (
                <g key={tick}>
                  <line x1={left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} />
                  <text x={left - 6} y={y(tick) + 4} textAnchor="end">
                    {tickText[index]}
                  </text>
                </g>
              ))}
              {/* Counted back from the latest, which always has its words. */}
              {points.map((row, index) =>
                (points.length - 1 - index) % every === 0 ? (
                  <text key={row.key} x={left + band * (index + 0.5)} y={LINE_HEIGHT - 6} textAnchor="middle">
                    {axisLabel(row)}
                  </text>
                ) : null,
              )}
            </g>
            {runs.map((run) => (
              <polyline
                key={run[0]!.index}
                className="app-tb-dash-line-path"
                points={run.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')}
              />
            ))}
            {runs.flat().map((point) => (
              <circle key={point.index} className="app-tb-dash-line-dot" cx={point.x} cy={point.y} r={3}>
                <title>
                  {t('tables.dashboards.figureOf', {
                    label: points[point.index]!.label,
                    value: formatFigure(points[point.index]!.value, locale, precision),
                  })}
                </title>
              </circle>
            ))}
          </svg>
        )}
      </div>
      <table className="app-sr-only">
        <caption>{label}</caption>
        <tbody>
          {all.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.label}</th>
              <td>{formatFigure(row.value, locale, precision)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {notes.length > 0 && (
        <ul className="app-tb-dash-notes" aria-hidden>
          {notes.map((row) => (
            <li key={row.key}>
              {t('tables.dashboards.figureOf', { label: row.label, value: formatFigure(row.value, locale, precision) })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A donut and its legend: each slice named with its figure and share. */
export function PieChart({ data, label, precision }: { data: GroupsData; label: string; precision?: number }) {
  const words = useI18n();
  const { t, locale } = words;
  const rows = rowsOf(data, words, true);
  const slices = pieSlices(rows.map((row) => row.value ?? 0));
  return (
    <div className="app-tb-dash-pie">
      <svg className="app-tb-dash-donut" viewBox="0 0 120 120" aria-hidden>
        {slices.map((slice, index) =>
          slice.share > 0 ? (
            <path
              key={rows[index]!.key}
              className={cx('app-tb-dash-slice', toneClass(rows[index]!.tone))}
              d={slicePath(60, 60, 56, 34, slice.start, slice.end)}
            />
          ) : null,
        )}
      </svg>
      <ul className="app-tb-dash-legend" aria-label={label}>
        {rows.map((row, index) => (
          <li key={row.key}>
            <span className={cx('app-tb-dash-swatch', toneClass(row.tone))} aria-hidden />
            <span className="app-tb-dash-legend-label" title={row.label}>
              {row.label}
            </span>
            <span className="app-tb-dash-legend-value">{formatFigure(row.value, locale, precision)}</span>
            <span className="app-tb-dash-legend-share">
              {t('tables.dashboards.share', { percent: Math.round((slices[index]?.share ?? 0) * 100) })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The first records, each a title that opens it in its table, then the card's fields. */
export function RecordList({
  data,
  card,
  baseId,
  table,
  label,
}: {
  data: ListData;
  card: Card;
  baseId: string;
  table: BaseTable | undefined;
  label: string;
}) {
  const { t } = useI18n();
  const { me } = useSession();
  const { memberById } = usePeople();
  const lookups: CellLookups = {
    members: memberById,
    linked: data.linked,
    files: data.files,
    timeZone: me?.timezone ?? 'Asia/Shanghai',
  };
  const fields = data.fields.flatMap((id) => table?.fields.find((field) => field.id === id) ?? []);
  return (
    <>
      <ul className="app-tb-dash-records" aria-label={label}>
        {data.items.map((record) => {
          const title = data.title_field ? record.values[data.title_field] : null;
          return (
            <li key={record.id} className="app-tb-dash-record">
              <a
                className="app-tb-dash-record-title"
                href={href({ page: 'base', id: baseId, table: card.table_id, record: record.id })}
              >
                {typeof title === 'string' && title ? title : t('tables.record.untitled')}
              </a>
              {fields.length > 0 && (
                <span className="app-tb-dash-record-fields">
                  {fields.map((field) => (
                    <span key={field.id} className="app-tb-dash-record-field">
                      <CellValue field={field} value={record.values[field.id]} lookups={lookups} />
                    </span>
                  ))}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {data.records > data.items.length && (
        <p className="app-tb-dash-caption">{t('tables.dashboards.listTotal', { count: data.records })}</p>
      )}
    </>
  );
}
