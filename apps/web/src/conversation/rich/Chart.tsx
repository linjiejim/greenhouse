/**
 * Charts from a `chart` block, drawn as SVG with the chart tokens: bar, line, pie, doughnut and
 * radar. No chart library: the shapes are simple and the colours must follow the theme.
 */

import type { ChartData } from '@greenhouse/types/rich-output';

const W = 640;
const H = 280;
const PAD = { top: 16, right: 16, bottom: 40, left: 48 };
const color = (index: number) => `var(--gh-chart-${(index % 8) + 1})`;

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * power >= value) ?? 10;
  return step * power;
}

const format = (value: number) =>
  Math.abs(value) >= 10_000 ? `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}k` : `${+value.toFixed(2)}`;

function Legend({ data }: { data: ChartData }) {
  const names = data.type === 'pie' || data.type === 'doughnut' ? data.labels : data.datasets.map((set) => set.label);
  if (names.length < 2) return null;
  return (
    <ul className="app-chart-legend">
      {names.map((name, index) => (
        <li key={`${name}-${index}`}>
          <span className="app-chart-swatch" style={{ background: color(index) }} />
          {name}
        </li>
      ))}
    </ul>
  );
}

function Axes({ max, labels }: { max: number; labels: string[] }) {
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((share) => share * max);
  const innerH = H - PAD.top - PAD.bottom;
  const innerW = W - PAD.left - PAD.right;
  const every = Math.max(1, Math.ceil(labels.length / 12));
  return (
    <g className="app-chart-axes">
      {ticks.map((tick) => {
        const y = PAD.top + innerH - (tick / max) * innerH;
        return (
          <g key={tick}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} />
            <text x={PAD.left - 8} y={y + 4} textAnchor="end">
              {format(tick)}
            </text>
          </g>
        );
      })}
      {labels.map((label, index) =>
        index % every === 0 ? (
          <text
            key={`${label}-${index}`}
            x={PAD.left + (innerW / labels.length) * (index + 0.5)}
            y={H - PAD.bottom + 18}
            textAnchor="middle"
          >
            {label.length > 10 ? `${label.slice(0, 9)}…` : label}
          </text>
        ) : null,
      )}
    </g>
  );
}

function Bars({ data }: { data: ChartData }) {
  const max = niceMax(Math.max(0, ...data.datasets.flatMap((set) => set.data)));
  const innerH = H - PAD.top - PAD.bottom;
  const band = (W - PAD.left - PAD.right) / Math.max(1, data.labels.length);
  const width = Math.max(2, (band * 0.7) / data.datasets.length);
  return (
    <>
      <Axes max={max} labels={data.labels} />
      {data.datasets.map((set, setIndex) =>
        set.data.map((value, index) => {
          const height = (Math.max(0, value) / max) * innerH;
          return (
            <rect
              key={`${setIndex}-${index}`}
              x={PAD.left + band * index + band * 0.15 + width * setIndex}
              y={PAD.top + innerH - height}
              width={width}
              height={height}
              rx={2}
              fill={color(setIndex)}
            >
              <title>{`${set.label} · ${data.labels[index] ?? ''}: ${value}`}</title>
            </rect>
          );
        }),
      )}
    </>
  );
}

function Lines({ data }: { data: ChartData }) {
  const max = niceMax(Math.max(0, ...data.datasets.flatMap((set) => set.data)));
  const innerH = H - PAD.top - PAD.bottom;
  const band = (W - PAD.left - PAD.right) / Math.max(1, data.labels.length);
  const point = (value: number, index: number) =>
    [PAD.left + band * (index + 0.5), PAD.top + innerH - (Math.max(0, value) / max) * innerH] as const;
  return (
    <>
      <Axes max={max} labels={data.labels} />
      {data.datasets.map((set, setIndex) => (
        <g key={setIndex}>
          <polyline
            fill="none"
            stroke={color(setIndex)}
            strokeWidth={2}
            points={set.data.map((value, index) => point(value, index).join(',')).join(' ')}
          />
          {set.data.length <= 60 &&
            set.data.map((value, index) => {
              const [x, y] = point(value, index);
              return (
                <circle key={index} cx={x} cy={y} r={3} fill={color(setIndex)}>
                  <title>{`${set.label} · ${data.labels[index] ?? ''}: ${value}`}</title>
                </circle>
              );
            })}
        </g>
      ))}
    </>
  );
}

function Pie({ data, hole }: { data: ChartData; hole: boolean }) {
  const values = (data.datasets[0]?.data ?? []).map((value) => Math.max(0, value));
  const total = values.reduce((sum, value) => sum + value, 0) || 1;
  const cx = W / 2;
  const cy = H / 2;
  const r = H / 2 - 16;
  let angle = -Math.PI / 2;
  return (
    <>
      {values.map((value, index) => {
        const sweep = (value / total) * Math.PI * 2;
        const start = angle;
        angle += sweep;
        const large = sweep > Math.PI ? 1 : 0;
        const [x1, y1] = [cx + r * Math.cos(start), cy + r * Math.sin(start)];
        const [x2, y2] = [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
        const path =
          sweep >= Math.PI * 2 - 1e-6
            ? `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0`
            : `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
        return (
          <path key={index} d={path} fill={color(index)} stroke="var(--gh-surface)" strokeWidth={1.5}>
            <title>{`${data.labels[index] ?? ''}: ${value} (${Math.round((value / total) * 100)}%)`}</title>
          </path>
        );
      })}
      {hole && <circle cx={cx} cy={cy} r={r * 0.55} fill="var(--gh-surface)" />}
    </>
  );
}

function Radar({ data }: { data: ChartData }) {
  const axes = data.labels.length;
  const cx = W / 2;
  const cy = H / 2;
  const r = H / 2 - 28;
  const max = niceMax(Math.max(0, ...data.datasets.flatMap((set) => set.data)));
  const at = (index: number, share: number) => {
    const angle = -Math.PI / 2 + (index / axes) * Math.PI * 2;
    return [cx + r * share * Math.cos(angle), cy + r * share * Math.sin(angle)] as const;
  };
  return (
    <g className="app-chart-axes">
      {[0.25, 0.5, 0.75, 1].map((share) => (
        <polygon
          key={share}
          fill="none"
          points={Array.from({ length: axes }, (_, index) => at(index, share).join(',')).join(' ')}
        />
      ))}
      {data.labels.map((label, index) => {
        const [x, y] = at(index, 1.12);
        return (
          <text key={`${label}-${index}`} x={x} y={y + 4} textAnchor="middle">
            {label.length > 10 ? `${label.slice(0, 9)}…` : label}
          </text>
        );
      })}
      {data.datasets.map((set, setIndex) => (
        <polygon
          key={setIndex}
          fill={color(setIndex)}
          fillOpacity={0.18}
          stroke={color(setIndex)}
          strokeWidth={2}
          points={set.data.map((value, index) => at(index, Math.max(0, value) / max).join(',')).join(' ')}
        />
      ))}
    </g>
  );
}

export function ChartView({ data }: { data: ChartData }) {
  return (
    <figure className="app-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={data.title ?? data.type}>
        {data.type === 'bar' && <Bars data={data} />}
        {data.type === 'line' && <Lines data={data} />}
        {(data.type === 'pie' || data.type === 'doughnut') && <Pie data={data} hole={data.type === 'doughnut'} />}
        {data.type === 'radar' && <Radar data={data} />}
      </svg>
      <Legend data={data} />
    </figure>
  );
}
