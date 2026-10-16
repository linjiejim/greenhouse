import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChartView } from '../Chart';

const count = (markup: string, tag: string) => (markup.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length;

describe('charts', () => {
  it('draws a bar per value and dataset, and a legend for several datasets', () => {
    const markup = renderToStaticMarkup(
      <ChartView
        data={{
          type: 'bar',
          labels: ['Mon', 'Tue', 'Wed'],
          datasets: [
            { label: 'Orders', data: [3, 5, 2] },
            { label: 'Returns', data: [1, 0, 1] },
          ],
        }}
      />,
    );
    expect(count(markup, 'rect')).toBe(6);
    expect(markup).toContain('Orders');
    expect(markup).toContain('Returns');
  });

  it('draws lines, pies, doughnuts and radars without failing on empty or zero data', () => {
    const base = { labels: ['a', 'b', 'c'], datasets: [{ label: 'x', data: [0, 0, 0] }] };
    for (const type of ['line', 'pie', 'doughnut', 'radar'] as const) {
      const markup = renderToStaticMarkup(<ChartView data={{ type, ...base }} />);
      expect(markup).toContain('<svg');
      expect(markup).not.toContain('NaN');
    }
    const empty = renderToStaticMarkup(<ChartView data={{ type: 'bar', labels: [], datasets: [] }} />);
    expect(empty).not.toContain('NaN');
  });

  it('gives a whole pie one full circle', () => {
    const markup = renderToStaticMarkup(
      <ChartView data={{ type: 'pie', labels: ['all'], datasets: [{ label: 'x', data: [7] }] }} />,
    );
    expect(count(markup, 'path')).toBe(1);
    expect(markup).not.toContain('NaN');
  });
});
