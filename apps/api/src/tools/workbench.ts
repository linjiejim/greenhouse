/**
 * Workbench tools — conversational configuration of the personal home page.
 *
 * The Home workbench lives in the Chat empty state, so "set up my home page" is
 * a request the user makes *in the conversation they are already having*. These
 * two tools are what makes that possible; without them the Customize entry point
 * would open a chat that cannot actually do anything.
 *
 * Owner-scoped by construction: every action resolves through the requesting
 * user's own preferences row, and a card can only bind a tool that user may
 * already call. The evaluation chain is injected (see WorkbenchToolContext) so
 * this module never imports the proxy registry — that would close an import
 * cycle through tools/registry.js.
 *
 * Writes are deliberately unconfirmed except for deletions: a card is personal,
 * reversible preference data that the user can undo on screen, and making them
 * confirm five times to build a dashboard would defeat the point. Removing a
 * card or a tab keeps the confirm gate every other mutation tool has.
 *
 * See docs/specs/20260805-home-workbench.md (D15).
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { DatabaseProvider } from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';
import {
  DEFAULT_TAB_ID,
  WIDGET_COLUMN_TYPES,
  WORKBENCH_LIMITS,
  availableRecipes,
  availableWorkbenchTemplates,
  findNextWidgetPosition,
  findRecipe,
  instantiateWorkbenchTemplate,
  isDataWidget,
  isNavWidget,
  parseWidget,
  type NavTarget,
  type ToolSource,
  type WorkbenchConfig,
  type WorkbenchNavResolution,
  type WorkbenchTab,
  type WorkbenchWidget,
} from '@greenhouse/types/workbench';
import { defineTool, type ToolMeta } from './define.js';
import { PLATFORM_ORG_ID } from '../platform/runtime.js';
import type { SourceOutcome } from '../workbench/evaluate.js';

export interface WorkbenchToolContext {
  userId: string;
  /** Read-only tools this user may bind a card to, resolved for this request. */
  readableToolIds: string[];
  /** Runs a card's query as this user — the same chain the rendered page uses. */
  evaluate: (source: ToolSource) => Promise<SourceOutcome>;
  /** Resolves a shortcut target through the same platform authorization chain. */
  evaluateNav: (target: NavTarget) => Promise<WorkbenchNavResolution>;
  /** Platform applications this user can actually see, resolved lazily. */
  listVisibleApplicationIds: () => Promise<string[]>;
}

// ─── Shared parameter pieces ─────────────────────────────

const mapSchema = z
  .object({
    rows: z.string().optional().describe('Dot path to the row array in the tool output, e.g. "items" or "companies".'),
    value: z
      .string()
      .optional()
      .describe('kpi only: dot path to the number, e.g. "stats.total_companies" or "rows.0.sale_price".'),
    x: z.string().optional().describe('chart only: row field for the category axis.'),
    y: z.string().array().optional().describe('chart only: row fields plotted as series.'),
    columns: z
      .object({
        key: z.string().describe('Row field, dot path allowed.'),
        label: z.string().optional(),
        type: z.enum(WIDGET_COLUMN_TYPES as unknown as [string, ...string[]]).optional(),
      })
      .array()
      .optional()
      .describe('table/list only: which row fields to show, in order.'),
  })
  .describe('How to read the tool output. Dot paths only — no expressions.');

const navSchema = z
  .object({
    app_id: z.string().optional().describe('Application id from the catalog, e.g. "crm" — links to its home.'),
    entity_kind: z.enum(['crm_company', 'crm_deal', 'project', 'kb_doc', 'tables_record']).optional(),
    entity_id: z.number().int().optional(),
    slug: z.string().optional().describe('kb_doc only.'),
    base_id: z.number().int().optional().describe('tables_record only.'),
    table_id: z.number().int().optional().describe('tables_record only.'),
  })
  .describe('Shortcut target. Give either app_id or entity_kind + entity_id.');

const workbenchQuerySchema = z.object({
  action: z
    .enum(['get', 'recipes', 'templates', 'preview'])
    .describe(
      'get: current cards, tabs and bindable tools. recipes: pre-wired cards. templates: permission-filtered starter workbenches. preview: run a candidate query and return its real output.',
    ),
  tool_id: z.string().optional().describe('preview: which read-only tool to call.'),
  input: z.record(z.string(), z.unknown()).optional().describe('preview: arguments for that tool.'),
});

const workbenchMutationSchema = z.object({
  action: z.enum([
    'apply_template',
    'add_widget',
    'update_widget',
    'remove_widget',
    'add_tab',
    'rename_tab',
    'remove_tab',
  ]),
  template_id: z.string().optional().describe('apply_template: id from workbench_query.templates.'),
  widget_id: z.string().optional().describe('Required for update_widget and remove_widget.'),
  tab_id: z
    .string()
    .optional()
    .describe('Which tab the card lives on (defaults to the first). Required for rename_tab and remove_tab.'),
  title: z.string().optional().describe('Card title, or the tab title for add_tab / rename_tab.'),
  recipe_id: z
    .string()
    .optional()
    .describe('Start from a recipe (see workbench_query.recipes); other fields override.'),
  tool_id: z.string().optional().describe('Read-only tool this card calls.'),
  input: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Arguments for that tool. Relative dates must use the tokens $today, $yesterday, $today-<N>d or $month_start — a literal date is wrong tomorrow.',
    ),
  display: z.enum(['kpi', 'chart', 'table', 'list']).optional(),
  chart_type: z.enum(['bar', 'line', 'pie', 'doughnut']).optional().describe('Required when display is chart.'),
  map: mapSchema.optional(),
  markdown: z.string().optional().describe('Makes this a note card instead of a data card.'),
  nav: navSchema.optional(),
  size: z
    .object({ w: z.number().int(), h: z.number().int() })
    .optional()
    .describe(`Grid size on a ${WORKBENCH_LIMITS.gridColumns}-column grid (w 1-12, h 1-12).`),
  confirm: z.boolean().optional().describe('Required by apply_template, remove_widget, and remove_tab.'),
});

type WorkbenchMutationInput = z.infer<typeof workbenchMutationSchema>;

// ─── Helpers ─────────────────────────────────────────────

function tabsOf(config: WorkbenchConfig): WorkbenchTab[] {
  return config.tabs.length > 0 ? config.tabs : [{ id: DEFAULT_TAB_ID, title: 'Overview', position: 0 }];
}

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function defaultSize(display: string | undefined): { w: number; h: number } {
  return display === 'kpi' ? { w: 3, h: 2 } : display === 'chart' ? { w: 6, h: 4 } : { w: 6, h: 5 };
}

/** Compact digest of a card summary — the model does not need the whole config. */
function describeWidget(widget: WorkbenchWidget) {
  return {
    id: widget.id,
    title: widget.title,
    kind: widget.kind,
    tab_id: widget.layout.tabId,
    ...(isDataWidget(widget)
      ? { display: widget.display, tool_id: widget.source.toolId, input: widget.source.input }
      : {}),
    ...(isNavWidget(widget) ? { target: widget.target } : {}),
  };
}

/**
 * What the card actually produced, right after it was saved.
 *
 * This is the point of writing without a confirm gate: instead of asking the
 * user to approve a card nobody has seen run, the model gets to look at the real
 * answer and fix a bad mapping itself. Kept small — a sample, not the payload.
 */
function summarizePreview(outcome: SourceOutcome): Record<string, unknown> {
  if (!outcome.ok) return { ok: false, error: outcome.error, ...(outcome.message ? { message: outcome.message } : {}) };
  const data = outcome.data;
  if (Array.isArray(data)) return { ok: true, sample: data.slice(0, 3) };
  if (data && typeof data === 'object') {
    const sampled: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      sampled[key] = Array.isArray(value) ? value.slice(0, 3) : value;
    }
    return { ok: true, sample: sampled };
  }
  return { ok: true, sample: data };
}

/** Build the widget draft from flat tool arguments, then validate it as stored config would be. */
function buildWidget(
  input: WorkbenchMutationInput,
  existing: WorkbenchWidget | undefined,
  config: WorkbenchConfig,
): { widget: WorkbenchWidget } | { error: string } {
  const recipe = findRecipe(input.recipe_id);
  if (input.recipe_id && !recipe) return { error: `Unknown recipe "${input.recipe_id}"` };

  const tabId = input.tab_id ?? existing?.layout.tabId ?? tabsOf(config)[0].id;
  if (!tabsOf(config).some((tab) => tab.id === tabId)) return { error: `Unknown tab "${tabId}"` };

  const markdown = input.markdown ?? (existing?.kind === 'text' ? existing.markdown : undefined);
  const navInput = input.nav;
  const display = input.display ?? recipe?.display ?? (existing && isDataWidget(existing) ? existing.display : 'table');

  let draft: Record<string, unknown>;
  if (markdown !== undefined && !input.tool_id && !recipe && !navInput) {
    draft = { kind: 'text', markdown };
  } else if (navInput) {
    const target = navInput.app_id
      ? { type: 'app', appId: navInput.app_id }
      : navInput.entity_kind && navInput.entity_id
        ? {
            type: 'entity',
            ref: {
              kind: navInput.entity_kind,
              id: navInput.entity_id,
              ...(navInput.slug ? { slug: navInput.slug } : {}),
              ...(navInput.base_id ? { baseId: navInput.base_id } : {}),
              ...(navInput.table_id ? { tableId: navInput.table_id } : {}),
            },
          }
        : null;
    if (!target) return { error: 'nav needs either app_id or entity_kind + entity_id' };
    draft = { kind: 'nav', target };
  } else {
    const toolId =
      input.tool_id ?? recipe?.toolId ?? (existing && isDataWidget(existing) ? existing.source.toolId : '');
    if (!toolId) return { error: 'A data card needs tool_id (or recipe_id)' };
    const source = {
      toolId,
      input: input.input ?? recipe?.source.input ?? (existing && isDataWidget(existing) ? existing.source.input : {}),
    };
    draft = {
      kind: 'data',
      display,
      ...(display === 'chart' ? { chartType: input.chart_type ?? recipe?.chartType ?? 'bar' } : {}),
      source,
      map: input.map ?? recipe?.map ?? (existing && isDataWidget(existing) ? existing.map : undefined),
      ...(recipe ? { recipeId: recipe.id } : {}),
    };
  }

  const size = input.size ?? recipe?.size ?? defaultSize(display);
  const position = findNextWidgetPosition(config.widgets, tabId, size.w, size.h);
  const widget = parseWidget({
    ...draft,
    id: existing?.id ?? newId('w'),
    title: input.title ?? existing?.title ?? recipe?.label ?? 'Card',
    layout: existing
      ? { ...existing.layout, tabId, ...(input.size ? { w: size.w, h: size.h } : {}) }
      : { tabId, ...position, w: size.w, h: size.h },
  });
  if (!widget) return { error: 'Those settings do not describe a valid card' };
  return { widget };
}

// ─── Tools ───────────────────────────────────────────────

export function createWorkbenchQueryTool(db: DatabaseProvider, ctx: WorkbenchToolContext) {
  return tool({
    description: workbenchQueryMeta.description,
    inputSchema: workbenchQuerySchema,
    execute: async (input) => {
      try {
        if (input.action === 'recipes') {
          return {
            recipes: availableRecipes(ctx.readableToolIds).map((recipe) => ({
              id: recipe.id,
              label: recipe.label,
              description: recipe.description,
              tool_id: recipe.toolId,
              display: recipe.display,
            })),
          };
        }

        if (input.action === 'templates') {
          const templates = availableWorkbenchTemplates({
            readableToolIds: ctx.readableToolIds,
            visibleApplicationIds: await ctx.listVisibleApplicationIds(),
          });
          return {
            templates: templates.map((template) => ({
              id: template.id,
              label: template.label,
              description: template.description,
              card_count: template.cards.length,
            })),
          };
        }

        if (input.action === 'preview') {
          if (!input.tool_id) return { error: 'preview needs tool_id' };
          const outcome = await ctx.evaluate({ toolId: input.tool_id, input: input.input ?? {} });
          return { preview: summarizePreview(outcome) };
        }

        const config = await db.platform.getUserWorkbenchPreferences(PLATFORM_ORG_ID, ctx.userId);
        return {
          tabs: tabsOf(config).map((tab) => ({ id: tab.id, title: tab.title })),
          widgets: config.widgets.map(describeWidget),
          bindable_tool_ids: ctx.readableToolIds,
          limits: { max_widgets: WORKBENCH_LIMITS.maxWidgets, max_tabs: WORKBENCH_LIMITS.maxTabs },
        };
      } catch (err) {
        return { error: toErrorMessage(err) };
      }
    },
  });
}

export function createWorkbenchMutationTool(db: DatabaseProvider, ctx: WorkbenchToolContext) {
  return tool({
    description: workbenchMutationMeta.description,
    inputSchema: workbenchMutationSchema,
    execute: async (input) => {
      try {
        const replacesOrRemoves =
          input.action === 'apply_template' || input.action === 'remove_widget' || input.action === 'remove_tab';
        if (replacesOrRemoves && input.confirm !== true) {
          return {
            error: `${input.action} replaces or deletes personal layout data — call again with confirm:true once the user agrees.`,
          };
        }

        const config = await db.platform.getUserWorkbenchPreferences(PLATFORM_ORG_ID, ctx.userId);
        const tabs = tabsOf(config);

        if (input.action === 'apply_template') {
          const template = availableWorkbenchTemplates({
            readableToolIds: ctx.readableToolIds,
            visibleApplicationIds: await ctx.listVisibleApplicationIds(),
          }).find((candidate) => candidate.id === input.template_id);
          if (!template) return { error: 'That workbench template is not available for this user.' };
          const instantiated = instantiateWorkbenchTemplate(template.id);
          if (!instantiated) return { error: 'That workbench template is invalid.' };

          // Applying a template is an explicit whole-dashboard replacement, not
          // a per-card delta. Keep application preferences from the row locked
          // by this mutation while replacing only tabs/widgets atomically.
          await db.platform.mutateUserWorkbenchPreferences(PLATFORM_ORG_ID, ctx.userId, (current) => ({
            ...current,
            tabs: instantiated.tabs,
            widgets: instantiated.widgets,
          }));
          const previews = await Promise.all(
            instantiated.widgets.map(async (widget) => ({
              widget: describeWidget(widget),
              preview: isDataWidget(widget) ? summarizePreview(await ctx.evaluate(widget.source)) : { ok: true },
            })),
          );
          return { ok: true, applied_template: template.id, cards: previews };
        }

        // ── Tabs ──
        if (input.action === 'add_tab') {
          if (!input.title) return { error: 'add_tab needs a title' };
          if (tabs.length >= WORKBENCH_LIMITS.maxTabs) return { error: `At most ${WORKBENCH_LIMITS.maxTabs} tabs.` };
          const tab = { id: newId('t'), title: input.title, position: tabs.length };
          const saved = await save(db, ctx.userId, config, { ...config, tabs: [...tabs, tab] });
          return { ok: true, tabs: tabsOf(saved).map((t) => ({ id: t.id, title: t.title })) };
        }

        if (input.action === 'rename_tab' || input.action === 'remove_tab') {
          const target = tabs.find((tab) => tab.id === input.tab_id);
          if (!target) return { error: `Unknown tab "${input.tab_id ?? ''}"` };
          if (input.action === 'rename_tab') {
            if (!input.title) return { error: 'rename_tab needs a title' };
            const nextTabs = tabs.map((tab) => (tab.id === target.id ? { ...tab, title: input.title! } : tab));
            const saved = await save(db, ctx.userId, config, { ...config, tabs: nextTabs });
            return { ok: true, tabs: tabsOf(saved).map((t) => ({ id: t.id, title: t.title })) };
          }
          if (tabs.length <= 1) return { error: 'The last tab cannot be removed.' };
          // Cards on a removed tab move to the first surviving tab rather than
          // disappearing with it — deleting a tab is not "delete these cards".
          const nextTabs = tabs.filter((tab) => tab.id !== target.id);
          const fallback = nextTabs[0].id;
          const saved = await save(db, ctx.userId, config, {
            ...config,
            tabs: nextTabs,
            widgets: config.widgets.map((widget) =>
              widget.layout.tabId === target.id ? { ...widget, layout: { ...widget.layout, tabId: fallback } } : widget,
            ),
          });
          return {
            ok: true,
            moved_cards_to: fallback,
            tabs: tabsOf(saved).map((t) => ({ id: t.id, title: t.title })),
          };
        }

        // ── Cards ──
        if (input.action === 'remove_widget') {
          const existing = config.widgets.find((widget) => widget.id === input.widget_id);
          if (!existing) return { error: `Unknown card "${input.widget_id ?? ''}"` };
          await save(db, ctx.userId, config, {
            ...config,
            widgets: config.widgets.filter((widget) => widget.id !== existing.id),
          });
          return { ok: true, removed: existing.id, title: existing.title };
        }

        const existing =
          input.action === 'update_widget' ? config.widgets.find((widget) => widget.id === input.widget_id) : undefined;
        if (input.action === 'update_widget' && !existing) {
          return { error: `Unknown card "${input.widget_id ?? ''}"` };
        }
        if (input.action === 'add_widget' && config.widgets.length >= WORKBENCH_LIMITS.maxWidgets) {
          return { error: `At most ${WORKBENCH_LIMITS.maxWidgets} cards.` };
        }

        const built = buildWidget(input, existing, { ...config, tabs });
        if ('error' in built) return { error: built.error };
        const { widget } = built;

        if (isDataWidget(widget) && !ctx.readableToolIds.includes(widget.source.toolId)) {
          return {
            error: `You cannot bind "${widget.source.toolId}" for this user. Bindable tools: ${ctx.readableToolIds.join(', ')}`,
          };
        }

        await save(db, ctx.userId, config, {
          ...config,
          tabs,
          widgets: existing
            ? config.widgets.map((candidate) => (candidate.id === widget.id ? widget : candidate))
            : [...config.widgets, widget],
        });

        // Run it once and hand back what it produced — an empty card is the
        // failure mode this whole path exists to catch.
        const preview = isDataWidget(widget)
          ? summarizePreview(await ctx.evaluate(widget.source))
          : isNavWidget(widget)
            ? await ctx.evaluateNav(widget.target)
            : { ok: true };
        return { ok: true, widget: describeWidget(widget), preview };
      } catch (err) {
        return { error: toErrorMessage(err) };
      }
    },
  });
}

function changed<T>(left: T, right: T): boolean {
  return JSON.stringify(left) !== JSON.stringify(right);
}

/**
 * Apply the delta between the tool's read snapshot and intended result onto the
 * latest row under the database lock. Independent Agent calls therefore compose
 * instead of whichever full JSON blob happens to arrive last winning.
 */
function mergeWorkbenchDelta(
  base: WorkbenchConfig,
  intended: WorkbenchConfig,
  current: WorkbenchConfig,
): WorkbenchConfig {
  const mergeById = <T extends { id: string }>(baseItems: T[], intendedItems: T[], currentItems: T[]): T[] => {
    const baseById = new Map(baseItems.map((item) => [item.id, item]));
    const intendedById = new Map(intendedItems.map((item) => [item.id, item]));
    const removed = new Set(baseItems.filter((item) => !intendedById.has(item.id)).map((item) => item.id));
    const updates = new Map(
      intendedItems
        .filter((item) => baseById.has(item.id) && changed(baseById.get(item.id), item))
        .map((item) => [item.id, item]),
    );
    const additions = intendedItems.filter((item) => !baseById.has(item.id));
    const merged = currentItems.filter((item) => !removed.has(item.id)).map((item) => updates.get(item.id) ?? item);
    for (const item of additions) {
      if (!merged.some((candidate) => candidate.id === item.id)) merged.push(item);
    }
    return merged;
  };

  const tabs = mergeById(base.tabs, intended.tabs, current.tabs);
  let widgets = mergeById(base.widgets, intended.widgets, current.widgets);
  // Two concurrent additions can both choose the same first-fit slot from the
  // same base snapshot. Preserve both, then re-place only the later addition
  // when its rectangle is no longer free in the latest config.
  const addedWidgetIds = new Set(
    intended.widgets.filter((widget) => !base.widgets.some((item) => item.id === widget.id)).map((widget) => widget.id),
  );
  for (const widgetId of addedWidgetIds) {
    const index = widgets.findIndex((widget) => widget.id === widgetId);
    if (index < 0) continue;
    const widget = widgets[index];
    const collides = widgets.some((other, otherIndex) => {
      if (otherIndex === index || other.layout.tabId !== widget.layout.tabId) return false;
      return (
        widget.layout.x < other.layout.x + other.layout.w &&
        widget.layout.x + widget.layout.w > other.layout.x &&
        widget.layout.y < other.layout.y + other.layout.h &&
        widget.layout.y + widget.layout.h > other.layout.y
      );
    });
    if (collides) {
      const others = widgets.filter((_, otherIndex) => otherIndex !== index);
      const position = findNextWidgetPosition(others, widget.layout.tabId, widget.layout.w, widget.layout.h);
      widgets[index] = { ...widget, layout: { ...widget.layout, ...position } };
    }
  }

  const removedTabIds = new Set(
    base.tabs.filter((tab) => !intended.tabs.some((next) => next.id === tab.id)).map((tab) => tab.id),
  );
  if (removedTabIds.size > 0 && tabs[0]) {
    widgets = widgets.map((widget) =>
      removedTabIds.has(widget.layout.tabId) ? { ...widget, layout: { ...widget.layout, tabId: tabs[0].id } } : widget,
    );
  }
  return { ...current, tabs, widgets };
}

async function save(
  db: DatabaseProvider,
  userId: string,
  base: WorkbenchConfig,
  intended: WorkbenchConfig,
): Promise<WorkbenchConfig> {
  return db.platform.mutateUserWorkbenchPreferences(PLATFORM_ORG_ID, userId, (current) =>
    mergeWorkbenchDelta(base, intended, current),
  );
}

// ─── Metadata ────────────────────────────────────────────

const workbenchQueryMeta: ToolMeta = {
  id: 'workbench_query',
  name: 'Workbench (read)',
  brief: 'Read the cards on this user’s home workbench',
  description: `Read this user's home workbench (Home / 首页 / 工作台). Call before changing it; action="templates" lists only permission-eligible starters.`,
  category: 'core',
  is_global: true,
  icon: 'LayoutGrid',
  // Deliberately no `surface`: personal UI configuration has no automation
  // consumer, and the write side pairs with a screen the user is looking at.
  sort_order: 38,
};

const workbenchMutationMeta: ToolMeta = {
  id: 'workbench_mutation',
  name: 'Workbench (write)',
  brief: 'Build and edit the cards on this user’s home workbench',
  description: `Edit this user's home workbench (Home / 首页 / 工作台). Cards save queries, never fetched answers. apply_template replaces all cards/tabs: summarize it, wait for agreement, then pass confirm:true. Inspect every returned preview; fix or remove empty cards.`,
  category: 'core',
  is_global: true,
  icon: 'LayoutGrid',
  runtime_risk: 'r1',
  sort_order: 39,
};

export const workbenchQueryTool = defineTool({ meta: workbenchQueryMeta, kind: 'lazy' });
export const workbenchMutationTool = defineTool({ meta: workbenchMutationMeta, kind: 'lazy' });
