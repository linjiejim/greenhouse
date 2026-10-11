/** @vitest-environment happy-dom */

/**
 * The host-agnostic card plumbing: `useTableCardResults` (per-card state over a
 * `TableCardDataProvider` — each card on its own, latest request wins, a failed
 * refresh keeps the last result) and `TableCardFrame` (the panel every card sits
 * in). The dashboard and app pages both build on these.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TableCardFilterValues, TableCardDataProvider, TableCardEvaluation } from './data-provider';
import { useTableCardResults } from './data-provider';
import { TableCardFrame } from './card-frame';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function kpi(value: number): TableCardEvaluation {
  return { card: { kind: 'kpi', aggregate: { operation: 'count' } }, result: { kind: 'kpi', value } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

type Results = ReturnType<typeof useTableCardResults<string>>;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

function mount(provider: TableCardDataProvider<string>, filters: TableCardFilterValues) {
  const latest: { current: Results | null } = { current: null };
  function Host({ values }: { values: TableCardFilterValues }) {
    latest.current = useTableCardResults(provider, values);
    return null;
  }
  const container = document.createElement('div');
  root = createRoot(container);
  act(() => root!.render(<Host values={filters} />));
  return {
    results: () => latest.current!,
    rerender: (values: TableCardFilterValues) => act(() => root!.render(<Host values={values} />)),
  };
}

describe('useTableCardResults', () => {
  it('asks the provider with the current filter values and the viewer zone, per card', async () => {
    const query = vi.fn(async (key: string) => kpi(key === 'a' ? 1 : 2));
    const host = mount({ query, loadFields: async () => [] }, { status: { kind: 'select', values: ['open'] } });

    await act(() => host.results().queryMany(['a', 'b']));

    expect(query).toHaveBeenCalledWith('a', {
      filterValues: { status: { kind: 'select', values: ['open'] } },
      timezone: host.results().timezone,
    });
    expect(host.results().timezone).toBeTruthy();
    expect(host.results().states.a?.result).toEqual({ kind: 'kpi', value: 1 });
    expect(host.results().states.b?.result).toEqual({ kind: 'kpi', value: 2 });
  });

  it('lands only the latest request of a card, whatever order the answers arrive in', async () => {
    const answers = [deferred<TableCardEvaluation>(), deferred<TableCardEvaluation>()];
    let call = 0;
    const host = mount({ query: () => answers[call++].promise, loadFields: async () => [] }, {});

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = host.results().query('a');
      second = host.results().query('a');
    });
    await act(async () => {
      answers[1].resolve(kpi(20));
      await second;
    });
    await act(async () => {
      answers[0].resolve(kpi(10));
      await first;
    });
    expect(host.results().states.a?.result).toEqual({ kind: 'kpi', value: 20 });
  });

  it('keeps the last result on screen when a refresh fails, with the error beside it', async () => {
    const query = vi.fn<TableCardDataProvider<string>['query']>().mockResolvedValueOnce(kpi(5));
    const host = mount({ query, loadFields: async () => [] }, {});
    await act(() => host.results().query('a'));

    query.mockRejectedValueOnce(new Error('gateway down'));
    host.rerender({ owner: null });
    await act(() => host.results().query('a'));

    expect(query).toHaveBeenLastCalledWith('a', expect.objectContaining({ filterValues: { owner: null } }));
    expect(host.results().states.a).toEqual({
      card: kpi(5).card,
      result: { kind: 'kpi', value: 5 },
      error: 'gateway down',
    });
  });
});

describe('TableCardFrame', () => {
  it('titles the panel, holds host actions, and is a drag handle only when asked', () => {
    const still = renderToStaticMarkup(
      <TableCardFrame title="Open orders" testId="card-1" actions={<button type="button">Edit</button>}>
        <p>body</p>
      </TableCardFrame>,
    );
    expect(still).toContain('data-testid="card-1"');
    expect(still).toContain('title="Open orders"');
    expect(still).toContain('<button type="button">Edit</button>');
    expect(still).toContain('<p>body</p>');
    expect(still).not.toContain('cursor-move');

    const draggable = renderToStaticMarkup(
      <TableCardFrame title="Open orders" draggable>
        <p>body</p>
      </TableCardFrame>,
    );
    expect(draggable).toContain('cursor-move');
  });
});
