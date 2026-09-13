import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChartBlock } from './chart-block';

describe('ChartBlock responsive viewport', () => {
  it('gives cartesian charts a full-width viewport with an explicit responsive height', () => {
    const html = renderToStaticMarkup(
      <ChartBlock
        compact
        data={{
          type: 'bar',
          title: 'Customer tiers',
          labels: ['S', 'A', 'B'],
          datasets: [{ label: 'Customers', data: [23, 34, 54] }],
        }}
      />,
    );

    expect(html).toContain('data-chart-viewport="cartesian"');
    expect(html).toContain('relative w-full h-[260px] sm:h-[320px]');
    expect(html).toContain('class="block h-full w-full"');
    expect(html).not.toContain('max-h-[300px]');
  });

  it('marks pie and doughnut charts as radial while retaining the full-width viewport', () => {
    const html = renderToStaticMarkup(
      <ChartBlock
        data={{
          type: 'doughnut',
          title: 'Sources',
          labels: ['Import', 'Manual'],
          datasets: [{ label: 'Customers', data: [56, 44] }],
        }}
      />,
    );

    expect(html).toContain('data-chart-viewport="radial"');
    expect(html).toContain('relative w-full h-[300px] sm:h-[360px]');
  });

  it('fills a dashboard card instead of keeping the chat reading height', () => {
    const html = renderToStaticMarkup(
      <ChartBlock
        fill
        compact
        data={{
          type: 'line',
          labels: ['Mon', 'Tue'],
          datasets: [{ label: 'Sales', data: [12, 18] }],
        }}
      />,
    );

    expect(html).toContain('flex h-full min-h-0 flex-col');
    expect(html).toContain('relative w-full h-full min-h-0');
    expect(html).not.toContain('h-[260px]');
  });
});
