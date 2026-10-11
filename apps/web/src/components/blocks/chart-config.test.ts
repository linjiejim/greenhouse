import { describe, expect, it } from 'vitest';
import { buildChartConfig, clickedPoint, withAlpha, type ChartTheme } from './chart-config';

const theme: ChartTheme = {
  text: '#111111',
  textMuted: '#222222',
  edge: '#333333',
  surface: '#ffffff',
  palette: ['#000001', '#000002', '#000003', '#000004', '#000005', '#000006', '#000007', '#000008'],
};

const twoSeries = {
  type: 'bar' as const,
  labels: ['Mar', 'Apr'],
  datasets: [
    { label: 'Open', data: [1, 0] },
    { label: 'Won', data: [2, 3] },
  ],
};

type Config = {
  type: string;
  plugins: unknown[];
  options: Record<string, any>;
  data: { datasets: Array<Record<string, any>> };
};
const build = (...args: Parameters<typeof buildChartConfig>) => buildChartConfig(...args) as unknown as Config;

describe('buildChartConfig', () => {
  it('stacks, turns bars horizontal, and colours datasets by the slots it is given', () => {
    const config = build(twoSeries, { stacked: true, horizontal: true, colorSlots: [4, 1] }, theme, 'Nunito');
    expect(config.options.indexAxis).toBe('y');
    expect(config.options.scales.x.stacked).toBe(true);
    expect(config.options.scales.y.stacked).toBe(true);
    expect(config.data.datasets.map((dataset) => dataset.backgroundColor)).toEqual(['#000005', '#000002']);
    // Stacked segments get a surface gap instead of rounded ends.
    expect(config.data.datasets[0]).toMatchObject({ borderWidth: 1, borderRadius: 0, borderColor: '#ffffff' });
  });

  it('never stacks a single series or a pie, and ignores horizontal for lines', () => {
    const single = build({ ...twoSeries, datasets: [twoSeries.datasets[0]!] }, { stacked: true }, theme, 'x');
    expect(single.options.scales.y.stacked).toBe(false);
    const line = build({ ...twoSeries, type: 'line' }, { horizontal: true, area: true }, theme, 'x');
    expect(line.options.indexAxis).toBeUndefined();
    expect(line.data.datasets[0]).toMatchObject({ fill: 'origin', borderWidth: 2, borderColor: '#000001' });
    expect(line.data.datasets[0]!.backgroundColor).toBe('rgba(0, 0, 1, 0.18)');
    const stackedArea = build({ ...twoSeries, type: 'line' }, { area: true, stacked: true }, theme, 'x');
    expect(stackedArea.data.datasets.map((dataset) => dataset.fill)).toEqual(['origin', '-1']);
  });

  it('colours pie slices per point and makes doughnuts hollow', () => {
    const pie = build(
      { type: 'doughnut', labels: ['a', 'b', 'c'], datasets: [{ label: 'n', data: [1, 2, 3] }] },
      { colorSlots: [2, 0, 9] },
      theme,
      'x',
    );
    expect(pie.data.datasets[0]!.backgroundColor).toEqual(['#000003', '#000001', '#000002']);
    expect(pie.options.cutout).toBe('58%');
    expect(pie.options.scales).toBeUndefined();
    expect(pie.options.plugins.legend.display).toBe(true);
  });

  it('adds the value-label plugin only when asked', () => {
    expect(build(twoSeries, {}, theme, 'x').plugins).toEqual([]);
    expect(build(twoSeries, { showValues: true }, theme, 'x').plugins).toHaveLength(1);
  });
});

describe('chart helpers', () => {
  it('maps a Chart.js click to the first mark under the pointer', () => {
    expect(clickedPoint([])).toBeNull();
    expect(
      clickedPoint([
        { datasetIndex: 1, index: 0 },
        { datasetIndex: 0, index: 0 },
      ]),
    ).toEqual({
      datasetIndex: 1,
      index: 0,
    });
  });

  it('adds alpha to hex and rgb colours only', () => {
    expect(withAlpha('#2b8a5e', 0.5)).toBe('rgba(43, 138, 94, 0.5)');
    expect(withAlpha('#fff', 1)).toBe('rgba(255, 255, 255, 1)');
    expect(withAlpha('rgb(1, 2, 3)', 0.2)).toBe('rgba(1, 2, 3, 0.2)');
    expect(withAlpha('var(--x)', 0.2)).toBe('var(--x)');
  });
});
