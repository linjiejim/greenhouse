/**
 * Blast-radius tests for the workbench tools.
 *
 * These let an LLM rewrite the user's home page, so the boundaries that matter
 * are: a card can only bind a tool the user may already call (the card is
 * re-evaluated as them forever after, so a bad binding is a standing request
 * they never made), deletions still need confirm while ordinary edits do not,
 * and a write hands back what the card actually produced — that live preview is
 * what pays for the missing confirm gate (spec D15).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { DatabaseProvider } from '@greenhouse/db';
import { parseWorkbenchConfig, type WorkbenchConfig } from '@greenhouse/types/workbench';
import { createWorkbenchQueryTool, createWorkbenchMutationTool, type WorkbenchToolContext } from '../workbench.js';
import type { SourceOutcome } from '../../workbench/evaluate.js';

let stored: WorkbenchConfig;
const evaluated: Array<{ toolId: string; input: Record<string, unknown> }> = [];
let nextOutcome: SourceOutcome = { ok: true, data: { rows: [{ value: 7 }] } };

const db = {
  platform: {
    async getUserWorkbenchPreferences() {
      return parseWorkbenchConfig(stored);
    },
    async setUserWorkbenchPreferences(_org: string, _user: string, config: WorkbenchConfig) {
      stored = parseWorkbenchConfig(config);
      return {} as never;
    },
    async mutateUserWorkbenchPreferences(
      _org: string,
      _user: string,
      mutate: (current: WorkbenchConfig) => WorkbenchConfig,
    ) {
      stored = parseWorkbenchConfig(mutate(parseWorkbenchConfig(stored)));
      return stored;
    },
  },
} as unknown as DatabaseProvider;

function context(
  readableToolIds = ['tables_query', 'project_query'],
  visibleApplicationIds = ['tables', 'projects'],
): WorkbenchToolContext {
  return {
    userId: 'u1',
    readableToolIds,
    evaluate: async (source) => {
      evaluated.push({ toolId: source.toolId, input: source.input });
      return nextOutcome;
    },
    evaluateNav: async () => ({ exists: true, allowed: true, title: 'Target' }),
    listVisibleApplicationIds: async () => visibleApplicationIds,
  };
}

type ToolResult = Record<string, unknown>;

/** Both tools are AI SDK tools; only their `execute` matters here. */
async function run(tool: unknown, input: unknown): Promise<ToolResult> {
  const execute = (tool as { execute?: (i: unknown, o: unknown) => Promise<unknown> }).execute;
  if (!execute) throw new Error('tool has no execute');
  return (await execute(input, { toolCallId: 't', messages: [] })) as ToolResult;
}

beforeEach(() => {
  stored = parseWorkbenchConfig({});
  evaluated.length = 0;
  nextOutcome = { ok: true, data: { rows: [{ value: 7 }] } };
});

describe('workbench_mutation', () => {
  it('refuses to bind a tool the user cannot read, and says which ones they can', async () => {
    const result = await run(createWorkbenchMutationTool(db, context()), {
      action: 'add_widget',
      title: 'Inbox',
      tool_id: 'email_query',
      input: { action: 'list' },
      display: 'kpi',
      map: { value: 'rows.0.count' },
    });

    expect(result.error).toContain('email_query');
    expect(result.error).toContain('tables_query');
    expect(stored.widgets).toHaveLength(0);
  });

  it('saves a card and hands back what it actually produced', async () => {
    const result = await run(createWorkbenchMutationTool(db, context()), {
      action: 'add_widget',
      title: 'Active projects',
      tool_id: 'project_query',
      input: { action: 'list', status: 'active' },
      display: 'kpi',
      map: { value: 'stats.total' },
    });

    expect(result.ok).toBe(true);
    expect(stored.widgets).toHaveLength(1);
    expect(result.preview).toEqual({ ok: true, sample: { rows: [{ value: 7 }] } });
    expect(evaluated).toEqual([{ toolId: 'project_query', input: { action: 'list', status: 'active' } }]);
  });

  it('reports a card that came back empty instead of claiming success', async () => {
    nextOutcome = { ok: false, error: 'failed', message: 'unknown action' };
    const result = await run(createWorkbenchMutationTool(db, context()), {
      action: 'add_widget',
      title: 'Broken',
      tool_id: 'project_query',
      input: { action: 'nope' },
      display: 'table',
    });

    // The card is still saved — the model decides whether to fix or drop it.
    expect(result.ok).toBe(true);
    expect(result.preview).toMatchObject({ ok: false, error: 'failed', message: 'unknown action' });
  });

  it('returns the real authorization result when it creates a shortcut', async () => {
    const ctx = context();
    ctx.evaluateNav = async () => ({ exists: true, allowed: false, title: 'Restricted app' });
    const result = await run(createWorkbenchMutationTool(db, ctx), {
      action: 'add_widget',
      title: 'Restricted',
      nav: { app_id: 'private-app' },
    });

    expect(result.ok).toBe(true);
    expect(result.preview).toEqual({ exists: true, allowed: false, title: 'Restricted app' });
  });

  it('applies a recipe by id, including its mapping and size', async () => {
    const result = await run(createWorkbenchMutationTool(db, context()), {
      action: 'add_widget',
      recipe_id: 'projects.active',
    });

    expect(result.ok).toBe(true);
    const widget = stored.widgets[0];
    expect(widget.kind).toBe('data');
    if (widget.kind !== 'data') throw new Error('expected a data card');
    expect(widget.source.toolId).toBe('project_query');
    expect(widget.source.input).toEqual({ action: 'list', status: 'active', limit: 15 });
    expect(widget.map?.rows).toBe('projects');
    expect(widget.title).toBe('Active projects');
    expect(widget.layout.w).toBe(6);
  });

  it('requires confirm to remove a card, and only then removes it', async () => {
    const tool = createWorkbenchMutationTool(db, context());
    await run(tool, { action: 'add_widget', recipe_id: 'projects.active' });
    const id = stored.widgets[0].id;

    const refused = await run(tool, { action: 'remove_widget', widget_id: id });
    expect(refused.error).toContain('confirm:true');
    expect(stored.widgets).toHaveLength(1);

    const removed = await run(tool, { action: 'remove_widget', widget_id: id, confirm: true });
    expect(removed.ok).toBe(true);
    expect(stored.widgets).toHaveLength(0);
  });

  it('adds a card without confirm — an edit the user can undo on screen', async () => {
    const result = await run(createWorkbenchMutationTool(db, context()), {
      action: 'add_widget',
      recipe_id: 'projects.list',
    });
    expect(result.error).toBeUndefined();
    expect(stored.widgets).toHaveLength(1);
  });

  it('requires confirm to replace the dashboard with a permission-filtered template', async () => {
    stored = parseWorkbenchConfig({
      appOrder: ['projects'],
      widgets: [
        {
          id: 'old',
          title: 'Old note',
          kind: 'text',
          markdown: 'keep me until confirmed',
          layout: { tabId: 'default', x: 0, y: 0, w: 4, h: 3 },
        },
      ],
    });
    const tool = createWorkbenchMutationTool(db, context(['project_query'], ['projects']));

    const refused = await run(tool, { action: 'apply_template', template_id: 'projects' });
    expect(refused.error).toContain('confirm:true');
    expect(stored.widgets.map((widget) => widget.id)).toEqual(['old']);

    const applied = await run(tool, { action: 'apply_template', template_id: 'projects', confirm: true });
    expect(applied).toMatchObject({ ok: true, applied_template: 'projects' });
    expect(stored.appOrder).toEqual(['projects']);
    expect(stored.widgets).toHaveLength(3);
    expect(stored.widgets.every((widget) => widget.kind === 'data')).toBe(true);
    expect(evaluated).toHaveLength(3);
  });

  it('does not apply a template for an application the user cannot see', async () => {
    const result = await run(createWorkbenchMutationTool(db, context(['project_query'], [])), {
      action: 'apply_template',
      template_id: 'projects',
      confirm: true,
    });
    expect(result.error).toContain('not available');
    expect(stored.widgets).toHaveLength(0);
  });

  it('composes concurrent additions from the same snapshot without overlapping them', async () => {
    const sharedSnapshot = parseWorkbenchConfig(stored);
    const concurrentDb = {
      platform: {
        async getUserWorkbenchPreferences() {
          return parseWorkbenchConfig(sharedSnapshot);
        },
        async mutateUserWorkbenchPreferences(
          _org: string,
          _user: string,
          mutate: (current: WorkbenchConfig) => WorkbenchConfig,
        ) {
          stored = parseWorkbenchConfig(mutate(parseWorkbenchConfig(stored)));
          return stored;
        },
      },
    } as unknown as DatabaseProvider;

    await Promise.all([
      run(createWorkbenchMutationTool(concurrentDb, context()), {
        action: 'add_widget',
        recipe_id: 'projects.list',
      }),
      run(createWorkbenchMutationTool(concurrentDb, context()), {
        action: 'add_widget',
        recipe_id: 'projects.list',
      }),
    ]);

    expect(stored.widgets).toHaveLength(2);
    const [left, right] = stored.widgets.map((widget) => widget.layout);
    const overlap =
      left.x < right.x + right.w &&
      left.x + left.w > right.x &&
      left.y < right.y + right.h &&
      left.y + left.h > right.y;
    expect(overlap).toBe(false);
  });

  it('rehomes cards when their tab is removed rather than deleting them with it', async () => {
    const tool = createWorkbenchMutationTool(db, context());
    await run(tool, { action: 'add_tab', title: 'Sales' });
    const extraTab = stored.tabs[stored.tabs.length - 1];
    await run(tool, { action: 'add_widget', recipe_id: 'projects.list', tab_id: extraTab.id });
    expect(stored.widgets[0].layout.tabId).toBe(extraTab.id);

    const result = await run(tool, { action: 'remove_tab', tab_id: extraTab.id, confirm: true });

    expect(result.ok).toBe(true);
    expect(stored.tabs.some((tab) => tab.id === extraTab.id)).toBe(false);
    expect(stored.widgets).toHaveLength(1);
    expect(stored.widgets[0].layout.tabId).toBe(stored.tabs[0].id);
  });

  it('rejects an unknown card id rather than silently creating one', async () => {
    const result = await run(createWorkbenchMutationTool(db, context()), {
      action: 'update_widget',
      widget_id: 'w_nope',
      title: 'Renamed',
    });
    expect(result.error).toContain('w_nope');
    expect(stored.widgets).toHaveLength(0);
  });
});

describe('workbench_query', () => {
  it('reports which tools this user can bind', async () => {
    const result = await run(createWorkbenchQueryTool(db, context(['tables_query'])), { action: 'get' });
    expect(result.bindable_tool_ids).toEqual(['tables_query']);
  });

  it('offers only recipes whose tool the user can call', async () => {
    const result = await run(createWorkbenchQueryTool(db, context(['project_query'])), { action: 'recipes' });
    const recipes = result.recipes as Array<{ id: string }>;
    expect(recipes.map((recipe) => recipe.id)).toEqual([
      'projects.list',
      'projects.active',
      'projects.planning',
      'projects.on_hold',
    ]);
  });

  it('lists only templates backed by both effective tools and visible applications', async () => {
    const result = await run(createWorkbenchQueryTool(db, context(['tables_query', 'project_query'], ['projects'])), {
      action: 'templates',
    });
    const templates = result.templates as Array<{ id: string }>;
    expect(templates.map((template) => template.id)).toEqual(['projects']);
  });

  it('previews a candidate query through the same permission chain', async () => {
    const tool = createWorkbenchQueryTool(db, context(['project_query']));
    const ok = await run(tool, { action: 'preview', tool_id: 'project_query', input: { action: 'list' } });
    expect(ok.preview).toMatchObject({ ok: true });

    nextOutcome = { ok: false, error: 'forbidden' };
    const denied = await run(tool, { action: 'preview', tool_id: 'email_query', input: {} });
    expect(denied.preview).toMatchObject({ ok: false, error: 'forbidden' });
  });
});
