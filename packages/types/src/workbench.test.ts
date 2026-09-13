/**
 * Workbench DSL contract.
 *
 * This parser is the single source of truth three consumers share (database
 * service, API validator, browser), so its lenient-but-bounded behaviour is
 * what keeps them from drifting — and what keeps one malformed card from
 * costing someone their whole home page.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TAB_ID,
  WORKBENCH_LIMITS,
  expandDateToken,
  expandDateTokens,
  availableWorkbenchTemplates,
  findNextWidgetPosition,
  instantiateWorkbenchTemplate,
  navEntitySource,
  parseWidget,
  parseWorkbenchConfig,
  readPath,
} from './workbench.js';

const layout = { tabId: 'main', x: 0, y: 0, w: 4, h: 3 };

describe('parseWorkbenchConfig', () => {
  it('migrates a v1 blob without losing application preferences', () => {
    expect(
      parseWorkbenchConfig({
        version: 1,
        appOrder: ['knowledge', 'projects'],
        pinnedAppIds: ['knowledge'],
        hiddenAppIds: ['projects'],
        defaultAppId: 'knowledge',
        density: 'compact',
      }),
    ).toEqual({
      version: 2,
      appOrder: ['knowledge', 'projects'],
      pinnedAppIds: ['knowledge'],
      hiddenAppIds: ['projects'],
      defaultAppId: 'knowledge',
      density: 'compact',
      tabs: [],
      widgets: [],
    });
  });

  it('accepts a JSON string as well as a decoded object', () => {
    const encoded = JSON.stringify({ version: 2, density: 'compact' });
    expect(parseWorkbenchConfig(encoded).density).toBe('compact');
    expect(parseWorkbenchConfig('not json').density).toBe('comfortable');
  });

  it('drops only the malformed cards and keeps the rest of the page', () => {
    const config = parseWorkbenchConfig({
      version: 2,
      tabs: [{ id: 'main', title: 'Overview', position: 0 }],
      widgets: [
        { id: 'good', title: 'Sales', kind: 'data', display: 'table', source: { toolId: 'project_query' }, layout },
        // Unknown kind, missing source, and chart without a type are all
        // unrenderable — but they must not take their neighbours down.
        { id: 'alien', title: 'Alien', kind: 'hologram', layout },
        { id: 'nosource', title: 'No source', kind: 'data', display: 'table', layout },
        { id: 'chart', title: 'Chart', kind: 'data', display: 'chart', source: { toolId: 'project_query' }, layout },
        { id: 'note', title: 'Note', kind: 'text', markdown: 'hello', layout },
      ],
    });
    expect(config.widgets.map((widget) => widget.id)).toEqual(['good', 'note']);
  });

  it('rehomes cards whose tab no longer exists instead of dropping them', () => {
    const config = parseWorkbenchConfig({
      version: 2,
      tabs: [{ id: 'kept', title: 'Kept', position: 0 }],
      widgets: [
        {
          id: 'orphan',
          title: 'Orphan',
          kind: 'text',
          markdown: 'x',
          layout: { ...layout, tabId: 'deleted' },
        },
      ],
    });
    expect(config.widgets[0].layout.tabId).toBe('kept');
  });

  it('falls back to the default tab id when no tabs are defined', () => {
    const config = parseWorkbenchConfig({
      version: 2,
      widgets: [{ id: 'a', title: 'A', kind: 'text', markdown: 'x', layout: { ...layout, tabId: 'gone' } }],
    });
    expect(config.widgets[0].layout.tabId).toBe(DEFAULT_TAB_ID);
  });

  it('enforces the card and tab ceilings', () => {
    const widgets = Array.from({ length: WORKBENCH_LIMITS.maxWidgets + 5 }, (_, index) => ({
      id: `w${index}`,
      title: 'Note',
      kind: 'text',
      markdown: 'x',
      layout,
    }));
    const tabs = Array.from({ length: WORKBENCH_LIMITS.maxTabs + 3 }, (_, index) => ({
      id: `t${index}`,
      title: `Tab ${index}`,
      position: index,
    }));
    const config = parseWorkbenchConfig({ version: 2, tabs, widgets });
    expect(config.widgets).toHaveLength(WORKBENCH_LIMITS.maxWidgets);
    expect(config.tabs).toHaveLength(WORKBENCH_LIMITS.maxTabs);
  });

  it('keeps a card inside the grid rather than discarding an off-grid layout', () => {
    const widget = parseWidget({
      id: 'wide',
      title: 'Wide',
      kind: 'text',
      markdown: 'x',
      layout: { tabId: 'main', x: 11, y: 0, w: 6, h: 3 },
    });
    expect(widget?.layout.x).toBe(WORKBENCH_LIMITS.gridColumns - 6);
  });

  it('refuses navigation targets for entity kinds with no read action', () => {
    // An unknown kind cannot be permission-checked, so it is never pinnable.
    expect(
      parseWidget({
        id: 'n',
        title: 'N',
        kind: 'nav',
        target: { type: 'entity', ref: { kind: 'mystery_record', id: 5 } },
        layout,
      }),
    ).toBeNull();
    expect(
      parseWidget({
        id: 'n',
        title: 'N',
        kind: 'nav',
        target: { type: 'entity', ref: { kind: 'project', id: 5 } },
        layout,
      }),
    ).not.toBeNull();
  });

  it('rejects field paths that are not plain dot paths', () => {
    const widget = parseWidget({
      id: 'm',
      title: 'M',
      kind: 'data',
      display: 'kpi',
      source: { toolId: 'project_query', input: {} },
      map: { value: 'stats.total; drop table', rows: 'items' },
      layout,
    });
    expect(widget && 'map' in widget ? widget.map : undefined).toEqual({ rows: 'items' });
  });
});

describe('readPath', () => {
  it('reads nested fields and array indices', () => {
    const data = { stats: { total: 7 }, rows: [{ value: 42 }] };
    expect(readPath(data, 'stats.total')).toBe(7);
    expect(readPath(data, 'rows.0.value')).toBe(42);
    expect(readPath(data, 'rows.5.value')).toBeUndefined();
    expect(readPath(data, 'missing.deep')).toBeUndefined();
  });
});

describe('date tokens', () => {
  const today = new Date('2026-08-05T09:00:00Z');

  it('expands the fixed vocabulary and leaves everything else alone', () => {
    expect(expandDateToken('$today', today)).toBe('2026-08-05');
    expect(expandDateToken('$yesterday', today)).toBe('2026-08-04');
    expect(expandDateToken('$today-30d', today)).toBe('2026-07-06');
    expect(expandDateToken('$month_start', today)).toBe('2026-08-01');
    expect(expandDateToken('2026-01-01', today)).toBeNull();
    expect(expandDateToken('$today-999d', today)).toBeNull();
  });

  it('expands tokens inside a saved tool input', () => {
    expect(
      expandDateTokens(
        {
          action: 'shop_overview',
          dateFrom: '$yesterday',
          limit: 10,
          query: { filters: [{ value: '$month_start' }, { value: ['$today-30d', 'literal'] }] },
        },
        today,
      ),
    ).toEqual({
      action: 'shop_overview',
      dateFrom: '2026-08-04',
      limit: 10,
      query: { filters: [{ value: '2026-08-01' }, { value: ['2026-07-06', 'literal'] }] },
    });
  });
});

describe('findNextWidgetPosition', () => {
  it('fills horizontal gaps before appending a new row', () => {
    const config = parseWorkbenchConfig({
      version: 2,
      tabs: [{ id: 'main', title: 'Main', position: 0 }],
      widgets: [
        { id: 'left', title: 'Left', kind: 'text', markdown: 'x', layout: { ...layout, x: 0, y: 0, w: 4 } },
        { id: 'right', title: 'Right', kind: 'text', markdown: 'x', layout: { ...layout, x: 8, y: 0, w: 4 } },
      ],
    });
    expect(findNextWidgetPosition(config.widgets, 'main', 4, 3)).toEqual({ x: 4, y: 0 });
  });

  it('keeps tab layouts independent', () => {
    const config = parseWorkbenchConfig({
      version: 2,
      widgets: [{ id: 'other', title: 'Other', kind: 'text', markdown: 'x', layout: { ...layout, tabId: 'other' } }],
    });
    expect(findNextWidgetPosition(config.widgets, 'main', 4, 3)).toEqual({ x: 0, y: 0 });
  });
});

describe('workbench templates', () => {
  it('hides a template unless both its data tool and application are available', () => {
    expect(
      availableWorkbenchTemplates({
        readableToolIds: ['project_query'],
        visibleApplicationIds: ['projects'],
      }).map((template) => template.id),
    ).toEqual(['projects']);

    expect(
      availableWorkbenchTemplates({
        readableToolIds: ['project_query'],
        visibleApplicationIds: [],
      }).map((template) => template.id),
    ).toEqual([]);

    expect(
      availableWorkbenchTemplates({
        readableToolIds: [],
        visibleApplicationIds: ['projects'],
      }).map((template) => template.id),
    ).toEqual([]);
  });

  it('instantiates verified recipe cards in a curated, aligned layout without overlaps', () => {
    const instantiated = instantiateWorkbenchTemplate('projects', (recipe) => `Localized ${recipe.label}`);
    expect(instantiated?.tabs).toEqual([]);
    expect(instantiated?.widgets).toHaveLength(3);
    expect(instantiated?.widgets[0].title).toBe('Localized Active projects');
    expect(instantiated?.widgets.every((widget) => widget.layout.tabId === DEFAULT_TAB_ID)).toBe(true);

    const widgets = instantiated?.widgets ?? [];
    for (const [index, widget] of widgets.entries()) {
      expect(
        widgets.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            widget.layout.x < other.layout.x + other.layout.w &&
            widget.layout.x + widget.layout.w > other.layout.x &&
            widget.layout.y < other.layout.y + other.layout.h &&
            widget.layout.y + widget.layout.h > other.layout.y,
        ),
      ).toBe(false);
    }

    expect(widgets.map((widget) => widget.layout)).toEqual([
      { tabId: DEFAULT_TAB_ID, x: 0, y: 0, w: 12, h: 4 },
      { tabId: DEFAULT_TAB_ID, x: 0, y: 4, w: 6, h: 4 },
      { tabId: DEFAULT_TAB_ID, x: 6, y: 4, w: 6, h: 4 },
    ]);
  });

  it('uses balanced rows for every first-party template', () => {
    expect(instantiateWorkbenchTemplate('projects')?.widgets.map((widget) => widget.layout)).toEqual([
      { tabId: DEFAULT_TAB_ID, x: 0, y: 0, w: 12, h: 4 },
      { tabId: DEFAULT_TAB_ID, x: 0, y: 4, w: 6, h: 4 },
      { tabId: DEFAULT_TAB_ID, x: 6, y: 4, w: 6, h: 4 },
    ]);
  });
});

describe('navEntitySource', () => {
  it('maps each pinnable kind onto its read action', () => {
    expect(navEntitySource({ kind: 'project', id: 3 })).toEqual({
      toolId: 'project_query',
      input: { action: 'get', project_id: 3 },
    });
    expect(navEntitySource({ kind: 'kb_doc', id: 9, slug: 'guide' })).toEqual({
      toolId: 'knowledge_query',
      input: { action: 'get', doc_id: '9' },
    });
  });
});
