/**
 * Home workbench configuration — the single source of truth for the personal
 * dashboard DSL, shared verbatim by the database service, the API validator and
 * the browser.
 *
 * Everything here is *shape*: types, limits, and a lenient parser. Nothing here
 * knows who the user is. Identity-dependent filtering — is this application in
 * your catalog, is this tool in your read set, does this record still exist —
 * belongs to the API layer, which is the only place with the answers. Keeping
 * the split at that seam is what lets one parser serve all three consumers
 * (previously three hand-written whitelists that drifted).
 *
 * The parser is deliberately wide-in / narrow-out: an unknown field is dropped,
 * an unparseable widget is dropped, and the rest of the config still loads. A
 * config is a person's home page — one bad card must never cost them the page.
 *
 * See docs/specs/20260805-home-workbench.md.
 */

import type { CoreEntityKind, EntityKind, EntityRef } from './entity-links.js';

export const WORKBENCH_LIMITS = {
  /** Cards per user. Caps the JSON blob and the batch-evaluation fan-out alike. */
  maxWidgets: 30,
  maxTabs: 6,
  maxTitleLength: 60,
  /** Characters in a text card's markdown body. */
  maxTextLength: 2000,
  /** Grid width. Widget `w` is clamped into 1..12 and `x + w` never exceeds it. */
  gridColumns: 12,
  maxWidgetHeight: 12,
  /** Series plotted by one chart card. */
  maxSeries: 6,
  maxColumns: 12,
  /** Requests accepted by one POST /api/workbench/query call. */
  maxQueryRequests: 30,
} as const;

// ─── Widget parts ────────────────────────────────────────

export type WidgetDisplay = 'kpi' | 'chart' | 'table' | 'list';
export type WidgetChartType = 'bar' | 'line' | 'pie' | 'doughnut';
/** Mirrors DataTableBlock's column types so a mapped column renders as-is. */
export type WidgetColumnType = 'text' | 'number' | 'currency' | 'percent' | 'boolean' | 'badge';

export const WIDGET_DISPLAYS: readonly WidgetDisplay[] = ['kpi', 'chart', 'table', 'list'];
export const WIDGET_CHART_TYPES: readonly WidgetChartType[] = ['bar', 'line', 'pie', 'doughnut'];
export const WIDGET_COLUMN_TYPES: readonly WidgetColumnType[] = [
  'text',
  'number',
  'currency',
  'percent',
  'boolean',
  'badge',
];

export interface WidgetLayout {
  tabId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Find the first open rectangle on a tab, scanning left-to-right then top-to-bottom.
 *
 * Both the browser editor and the conversational workbench tool add cards. Keeping
 * placement here prevents either path from reverting to the old "always x=0,
 * append below everything" behaviour that left large holes in a 12-column grid.
 */
export function findNextWidgetPosition(
  widgets: readonly WorkbenchWidget[],
  tabId: string,
  width: number,
  height: number,
): Pick<WidgetLayout, 'x' | 'y'> {
  const w = Math.min(WORKBENCH_LIMITS.gridColumns, Math.max(1, Math.round(width)));
  const h = Math.min(WORKBENCH_LIMITS.maxWidgetHeight, Math.max(1, Math.round(height)));
  const occupied = widgets.filter((widget) => widget.layout.tabId === tabId);

  const overlaps = (x: number, y: number, widget: WorkbenchWidget) => {
    const layout = widget.layout;
    return x < layout.x + layout.w && x + w > layout.x && y < layout.y + layout.h && y + h > layout.y;
  };

  for (let y = 0; y <= 999; y += 1) {
    for (let x = 0; x <= WORKBENCH_LIMITS.gridColumns - w; x += 1) {
      if (!occupied.some((widget) => overlaps(x, y, widget))) return { x, y };
    }
  }
  return { x: 0, y: 999 };
}

/**
 * A saved read-only tool call: *what to ask*, never *what the answer was*.
 *
 * Storing the intent rather than a snapshot is what makes permissions correct by
 * construction — every render re-runs it as the current user, so revoking access
 * greys the card out instead of leaking yesterday's rows.
 */
export interface ToolSource {
  toolId: string;
  input: Record<string, unknown>;
}

/**
 * How to read a tool's JSON output. Dot paths only (`a.b.c`) — no expressions,
 * no computation. Anything a path can't express is a job for a recipe or a new
 * tool action, not for a mini language stored in user config.
 */
export interface FieldMap {
  /** Path to the array of rows. Omitted for kpi cards that read a scalar. */
  rows?: string;
  /** kpi: path to the scalar value. */
  value?: string;
  /** chart: row field for the category axis. */
  x?: string;
  /** chart: row fields plotted as series. */
  y?: string[];
  /** table / list: row fields to show, in order. */
  columns?: WidgetColumn[];
}

export interface WidgetColumn {
  key: string;
  label?: string;
  type?: WidgetColumnType;
}

/**
 * Where a navigation card points.
 *
 * `entity` reuses {@link EntityRef} — the same ref the Markdown renderer, the
 * global search palette and the detail peek already speak, so pinning a record
 * needs no second addressing scheme. `app` points at a catalog application's
 * own home.
 */
export type NavTarget = { type: 'app'; appId: string } | { type: 'entity'; ref: EntityRef };

/**
 * Read-only tool call that answers "does this record still exist, and may this
 * user see it?" for each entity kind.
 *
 * Navigation cards resolve through the same tool surface as data cards, so the
 * workbench has exactly one permission chain rather than a second per-entity
 * authorization path. Kinds mapped to `null` have no read action today and are
 * therefore not offered as pin targets — an honest gap, not a silent bypass.
 */
export const NAV_ENTITY_RESOLVERS: Readonly<Record<CoreEntityKind, { toolId: string; action: string } | null>> =
  Object.freeze({
    project: { toolId: 'project_query', action: 'get' },
    kb_doc: { toolId: 'knowledge_query', action: 'get' },
    tables_record: { toolId: 'tables_query', action: 'records.get' },
  });

/**
 * Resolver for a kind, or undefined when there is none. Extension record kinds
 * have no resolver today: they get deeplinks, peeks and search, but not
 * workbench pinning (that needs a read tool + action mapping per kind).
 */
export function navEntityResolver(kind: EntityKind): { toolId: string; action: string } | null | undefined {
  return (NAV_ENTITY_RESOLVERS as Record<string, { toolId: string; action: string } | null>)[kind];
}

/** Entity kinds a navigation card can point at. */
export const PINNABLE_ENTITY_KINDS: readonly EntityKind[] = (
  Object.keys(NAV_ENTITY_RESOLVERS) as CoreEntityKind[]
).filter((kind) => NAV_ENTITY_RESOLVERS[kind] !== null);

/** Build the resolver call for a ref, or null when the kind is unpinnable. */
export function navEntitySource(ref: EntityRef): ToolSource | null {
  const resolver = navEntityResolver(ref.kind);
  if (!resolver) return null;
  switch (ref.kind) {
    case 'project':
      return { toolId: resolver.toolId, input: { action: resolver.action, project_id: ref.id } };
    case 'kb_doc':
      return { toolId: resolver.toolId, input: { action: resolver.action, doc_id: String(ref.id) } };
    case 'tables_record':
      return {
        toolId: resolver.toolId,
        input: { action: resolver.action, table_id: ref.tableId, record_id: ref.id },
      };
    default:
      return null;
  }
}

// ─── Widgets ─────────────────────────────────────────────

export interface WorkbenchWidgetBase {
  id: string;
  title: string;
  layout: WidgetLayout;
}

export interface DataWidget extends WorkbenchWidgetBase {
  kind: 'data';
  display: WidgetDisplay;
  /** Required when `display === 'chart'`; ignored otherwise. */
  chartType?: WidgetChartType;
  source: ToolSource;
  map?: FieldMap;
  /** Recipe this card started from. Provenance only — never re-applied. */
  recipeId?: string;
}

export interface NavWidget extends WorkbenchWidgetBase {
  kind: 'nav';
  target: NavTarget;
}

export interface TextWidget extends WorkbenchWidgetBase {
  kind: 'text';
  markdown: string;
}

export type WorkbenchWidget = DataWidget | NavWidget | TextWidget;

export interface WorkbenchTab {
  id: string;
  title: string;
  position: number;
}

/**
 * The whole personal workbench blob.
 *
 * v1 fields (the Apps catalog preferences) are carried forward untouched: the
 * same row stores both, and an old client's config must survive a v2 read.
 */
export interface WorkbenchConfig {
  version: 2;
  appOrder: string[];
  pinnedAppIds: string[];
  hiddenAppIds: string[];
  defaultAppId: string | null;
  density: 'comfortable' | 'compact';
  tabs: WorkbenchTab[];
  widgets: WorkbenchWidget[];
}

export const DEFAULT_TAB_ID = 'default';

export const DEFAULT_WORKBENCH_CONFIG: Readonly<WorkbenchConfig> = Object.freeze({
  version: 2,
  appOrder: [],
  pinnedAppIds: [],
  hiddenAppIds: [],
  defaultAppId: null,
  density: 'comfortable',
  tabs: [],
  widgets: [],
});

// ─── Parsing ─────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A short, whitespace-free identifier. Membership checks live in the API layer. */
function cleanId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64 || /\s/.test(trimmed)) return null;
  return trimmed;
}

function idList(value: unknown, limit = 100): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const id = cleanId(item);
    if (id && !out.includes(id)) out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

/** Finite integer clamped into range; non-numbers fall back to `fallback`. */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** A dot path like `a.b.c`. Rejects anything that could address more than a field. */
function cleanPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 120) return null;
  return /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/.test(trimmed) ? trimmed : null;
}

function parseLayout(value: unknown): WidgetLayout {
  const record = isRecord(value) ? value : {};
  const w = clampInt(record.w, 1, WORKBENCH_LIMITS.gridColumns, 4);
  const x = clampInt(record.x, 0, WORKBENCH_LIMITS.gridColumns - 1, 0);
  return {
    tabId: cleanId(record.tabId) ?? DEFAULT_TAB_ID,
    // Keep the card inside the grid rather than dropping it: an off-grid x is a
    // layout bug, not a reason to lose the user's card.
    x: Math.min(x, WORKBENCH_LIMITS.gridColumns - w),
    y: clampInt(record.y, 0, 999, 0),
    w,
    h: clampInt(record.h, 1, WORKBENCH_LIMITS.maxWidgetHeight, 4),
  };
}

function parseToolSource(value: unknown): ToolSource | null {
  if (!isRecord(value)) return null;
  const toolId = cleanId(value.toolId);
  if (!toolId) return null;
  return { toolId, input: isRecord(value.input) ? value.input : {} };
}

function parseColumns(value: unknown): WidgetColumn[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const columns: WidgetColumn[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const key = cleanPath(item.key);
    if (!key) continue;
    const type = WIDGET_COLUMN_TYPES.find((candidate) => candidate === item.type);
    const label = cleanText(item.label, WORKBENCH_LIMITS.maxTitleLength);
    columns.push({ key, ...(label ? { label } : {}), ...(type ? { type } : {}) });
    if (columns.length >= WORKBENCH_LIMITS.maxColumns) break;
  }
  return columns.length ? columns : undefined;
}

function parseFieldMap(value: unknown): FieldMap | undefined {
  if (!isRecord(value)) return undefined;
  const rows = cleanPath(value.rows);
  const scalar = cleanPath(value.value);
  const x = cleanPath(value.x);
  const y = Array.isArray(value.y)
    ? value.y
        .map((item) => cleanPath(item))
        .filter((path): path is string => path !== null)
        .slice(0, WORKBENCH_LIMITS.maxSeries)
    : [];
  const columns = parseColumns(value.columns);
  const map: FieldMap = {
    ...(rows ? { rows } : {}),
    ...(scalar ? { value: scalar } : {}),
    ...(x ? { x } : {}),
    ...(y.length ? { y } : {}),
    ...(columns ? { columns } : {}),
  };
  return Object.keys(map).length ? map : undefined;
}

function parseEntityRef(value: unknown): EntityRef | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'number' && Number.isSafeInteger(value.id) && value.id > 0 ? value.id : null;
  if (id === null) return null;
  switch (value.kind) {
    case 'project':
      return { kind: value.kind, id };
    case 'kb_doc': {
      const slug = typeof value.slug === 'string' && value.slug.trim() ? value.slug.trim().slice(0, 120) : null;
      return slug ? { kind: 'kb_doc', id, slug } : null;
    }
    case 'tables_record': {
      const baseId = typeof value.baseId === 'number' && value.baseId > 0 ? Math.round(value.baseId) : null;
      const tableId = typeof value.tableId === 'number' && value.tableId > 0 ? Math.round(value.tableId) : null;
      return baseId && tableId ? { kind: 'tables_record', baseId, tableId, id } : null;
    }
    default:
      return null;
  }
}

function parseNavTarget(value: unknown): NavTarget | null {
  if (!isRecord(value)) return null;
  if (value.type === 'app') {
    const appId = cleanId(value.appId);
    return appId ? { type: 'app', appId } : null;
  }
  if (value.type === 'entity') {
    const ref = parseEntityRef(value.ref);
    // An unpinnable kind can't be resolved, so it can't be stored either.
    return ref && navEntityResolver(ref.kind) ? { type: 'entity', ref } : null;
  }
  return null;
}

/** One widget, or null when it is too malformed to render. */
export function parseWidget(value: unknown): WorkbenchWidget | null {
  if (!isRecord(value)) return null;
  const id = cleanId(value.id);
  const title = cleanText(value.title, WORKBENCH_LIMITS.maxTitleLength);
  if (!id || !title) return null;
  const layout = parseLayout(value.layout);

  if (value.kind === 'data') {
    const source = parseToolSource(value.source);
    if (!source) return null;
    const display = WIDGET_DISPLAYS.find((candidate) => candidate === value.display) ?? 'table';
    const chartType = WIDGET_CHART_TYPES.find((candidate) => candidate === value.chartType);
    if (display === 'chart' && !chartType) return null;
    const map = parseFieldMap(value.map);
    const recipeId = cleanId(value.recipeId);
    return {
      kind: 'data',
      id,
      title,
      layout,
      display,
      ...(display === 'chart' && chartType ? { chartType } : {}),
      source,
      ...(map ? { map } : {}),
      ...(recipeId ? { recipeId } : {}),
    };
  }

  if (value.kind === 'nav') {
    const target = parseNavTarget(value.target);
    return target ? { kind: 'nav', id, title, layout, target } : null;
  }

  if (value.kind === 'text') {
    const markdown = cleanText(value.markdown, WORKBENCH_LIMITS.maxTextLength);
    return markdown ? { kind: 'text', id, title, layout, markdown } : null;
  }

  return null;
}

function parseTabs(value: unknown): WorkbenchTab[] {
  if (!Array.isArray(value)) return [];
  const tabs: WorkbenchTab[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = cleanId(item.id);
    const title = cleanText(item.title, WORKBENCH_LIMITS.maxTitleLength);
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    tabs.push({ id, title, position: clampInt(item.position, 0, 999, tabs.length) });
    if (tabs.length >= WORKBENCH_LIMITS.maxTabs) break;
  }
  return tabs.sort((left, right) => left.position - right.position).map((tab, index) => ({ ...tab, position: index }));
}

/**
 * Parse stored workbench config from a JSON string or an already-decoded value.
 *
 * Accepts both so the database service (which holds a text column), the API
 * validator (which holds a request body) and the browser (which holds a parsed
 * response) can all call the identical function.
 *
 * v1 blobs — which have no `tabs` / `widgets` — parse into a v2 config with an
 * empty dashboard, so upgrading costs no migration and loses no app preference.
 */
export function parseWorkbenchConfig(value: unknown): WorkbenchConfig {
  let decoded = value;
  if (typeof decoded === 'string') {
    try {
      decoded = JSON.parse(decoded);
    } catch {
      return { ...DEFAULT_WORKBENCH_CONFIG };
    }
  }
  if (!isRecord(decoded)) return { ...DEFAULT_WORKBENCH_CONFIG };

  const hiddenAppIds = idList(decoded.hiddenAppIds);
  const pinnedAppIds = idList(decoded.pinnedAppIds).filter((appId) => !hiddenAppIds.includes(appId));
  const defaultAppId = cleanId(decoded.defaultAppId);

  const widgets: WorkbenchWidget[] = [];
  const seenWidgetIds = new Set<string>();
  if (Array.isArray(decoded.widgets)) {
    for (const item of decoded.widgets) {
      const widget = parseWidget(item);
      if (!widget || seenWidgetIds.has(widget.id)) continue;
      seenWidgetIds.add(widget.id);
      widgets.push(widget);
      if (widgets.length >= WORKBENCH_LIMITS.maxWidgets) break;
    }
  }

  const tabs = parseTabs(decoded.tabs);
  // Every widget needs a home. Cards whose tab vanished move to the first tab
  // rather than disappearing with it.
  const tabIds = new Set(tabs.map((tab) => tab.id));
  const fallbackTabId = tabs[0]?.id ?? DEFAULT_TAB_ID;
  const placedWidgets = widgets.map((widget) =>
    tabIds.has(widget.layout.tabId) ? widget : { ...widget, layout: { ...widget.layout, tabId: fallbackTabId } },
  );

  return {
    version: 2,
    appOrder: idList(decoded.appOrder),
    pinnedAppIds,
    hiddenAppIds,
    defaultAppId: defaultAppId && !hiddenAppIds.includes(defaultAppId) ? defaultAppId : null,
    density: decoded.density === 'compact' ? 'compact' : 'comfortable',
    tabs,
    widgets: placedWidgets,
  };
}

// ─── Guards ──────────────────────────────────────────────

export function isDataWidget(widget: WorkbenchWidget): widget is DataWidget {
  return widget.kind === 'data';
}

export function isNavWidget(widget: WorkbenchWidget): widget is NavWidget {
  return widget.kind === 'nav';
}

export function isTextWidget(widget: WorkbenchWidget): widget is TextWidget {
  return widget.kind === 'text';
}

// ─── Recipes ─────────────────────────────────────────────

/**
 * A recipe is a fully-configured card: which read-only tool to call, with what
 * input, and how to read the answer.
 *
 * It lives here rather than in the browser because two consumers need the exact
 * same list — the card picker and `workbench_query.recipes`, which is how the
 * agent learns what it can build. Two copies of this table would drift the day
 * one of them gained an entry.
 *
 * Every entry below was checked against the tool's actual zod schema and its
 * real return shape. Do not add one from memory: a recipe that renders an empty
 * card is worse than an absent recipe, and "capability claims must be true" is a
 * repo rule, not a preference.
 *
 * Anything without a recipe stays reachable through the generic builder and
 * through the agent, which can run `workbench_query.preview` and see the real
 * shape before committing a card.
 */
export type CoreWidgetRecipeId = 'projects.list' | 'projects.active' | 'projects.planning' | 'projects.on_hold';
/** A core id, or an extension's own (conventionally `<extension id>.<name>`). */
export type WidgetRecipeId = CoreWidgetRecipeId | (string & {});

export interface WidgetRecipe {
  id: WidgetRecipeId;
  /** Must be in the user's read set for this recipe to be offered. */
  toolId: string;
  /** English label — what the agent reads. The browser renders its own translation. */
  label: string;
  description: string;
  display: WidgetDisplay;
  chartType?: WidgetChartType;
  source: ToolSource;
  map?: FieldMap;
  /** Default grid size, in the 12-column vocabulary. */
  size: { w: number; h: number };
  /**
   * Translation keys for the browser (extensions only — core recipes are
   * translated from the closed table in apps/web/src/lib/workbench/recipes.ts).
   * Without them the English `label` / `description` above render as-is.
   */
  labelKey?: string;
  descriptionKey?: string;
}

export const WIDGET_RECIPES: readonly WidgetRecipe[] = [
  // ── Projects ──────────────────────────────────────────
  {
    id: 'projects.list',
    toolId: 'project_query',
    label: 'Projects',
    description: 'Your current projects and their status',
    display: 'table',
    source: { toolId: 'project_query', input: { action: 'list', limit: 15 } },
    map: {
      rows: 'projects',
      columns: [
        { key: 'title', type: 'text' },
        { key: 'status', type: 'badge' },
      ],
    },
    size: { w: 6, h: 5 },
  },
  {
    id: 'projects.active',
    toolId: 'project_query',
    label: 'Active projects',
    description: 'Projects currently in active execution',
    display: 'table',
    source: { toolId: 'project_query', input: { action: 'list', status: 'active', limit: 15 } },
    map: {
      rows: 'projects',
      columns: [
        { key: 'title', type: 'text' },
        { key: 'priority', type: 'badge' },
        // project_query returns an already-scaled 0..100 percentage.
        { key: 'progress_percent', type: 'number' },
        { key: 'end_date', type: 'text' },
      ],
    },
    size: { w: 6, h: 5 },
  },
  {
    id: 'projects.planning',
    toolId: 'project_query',
    label: 'Projects in planning',
    description: 'Projects still being planned',
    display: 'table',
    source: { toolId: 'project_query', input: { action: 'list', status: 'planning', limit: 15 } },
    map: {
      rows: 'projects',
      columns: [
        { key: 'title', type: 'text' },
        { key: 'priority', type: 'badge' },
        { key: 'owner', type: 'text' },
        { key: 'start_date', type: 'text' },
      ],
    },
    size: { w: 6, h: 5 },
  },
  {
    id: 'projects.on_hold',
    toolId: 'project_query',
    label: 'Projects on hold',
    description: 'Projects that are currently paused',
    display: 'table',
    source: { toolId: 'project_query', input: { action: 'list', status: 'on_hold', limit: 15 } },
    map: {
      rows: 'projects',
      columns: [
        { key: 'title', type: 'text' },
        { key: 'priority', type: 'badge' },
        { key: 'owner', type: 'text' },
        { key: 'end_date', type: 'text' },
      ],
    },
    size: { w: 6, h: 5 },
  },
];

// ─── Extension recipes ───────────────────────────────────

const extensionRecipes: WidgetRecipe[] = [];

/** Register the workbench cards an extension offers. Called at boot. */
export function registerWidgetRecipes(recipes: readonly WidgetRecipe[]): void {
  for (const recipe of recipes) {
    if (allWidgetRecipes().some((existing) => existing.id === recipe.id)) {
      throw new Error(`Widget recipe "${recipe.id}" is already registered`);
    }
    extensionRecipes.push(recipe);
  }
}

/** Core recipes followed by every registered extension recipe. */
export function allWidgetRecipes(): readonly WidgetRecipe[] {
  return [...WIDGET_RECIPES, ...extensionRecipes];
}

/** Test hook — forget recipes registered by a suite. */
export function _resetExtensionWidgetRecipes(): void {
  extensionRecipes.length = 0;
}

export function findRecipe(recipeId: string | undefined): WidgetRecipe | undefined {
  return recipeId ? allWidgetRecipes().find((recipe) => recipe.id === recipeId) : undefined;
}

/**
 * Recipes whose tool the current user can actually call.
 *
 * Hidden rather than disabled: a permanently unusable entry reads as broken,
 * and listing it would leak which tools exist.
 */
export function availableRecipes(readableToolIds: ReadonlySet<string> | readonly string[]): WidgetRecipe[] {
  const readable = readableToolIds instanceof Set ? readableToolIds : new Set(readableToolIds);
  return allWidgetRecipes().filter((recipe) => readable.has(recipe.toolId));
}

// ─── Workbench templates ────────────────────────────────

/**
 * A curated starter workbench assembled entirely from verified recipes.
 *
 * Templates do not add another persistence concept: selecting one replaces the
 * personal blob's tabs/widgets and leaves the existing application preferences
 * untouched. They also carry the permissions needed to decide whether the
 * choice should exist at all. A disabled card in a picker is a capability leak
 * and a broken promise; inaccessible templates are hidden instead.
 */
export type WorkbenchTemplateId = 'projects';

export interface WorkbenchTemplateCard {
  recipeId: WidgetRecipeId;
  /** Curated desktop placement. Mobile still stacks cards in this order. */
  layout: Omit<WidgetLayout, 'tabId'>;
}

export interface WorkbenchTemplate {
  id: WorkbenchTemplateId;
  /** English copy for Agent tools. The browser owns translated labels. */
  label: string;
  description: string;
  cards: readonly WorkbenchTemplateCard[];
  requiredToolIds: readonly string[];
  /** Platform applications that must be visible in the user's catalog. */
  requiredApplicationIds: readonly string[];
}

export const WORKBENCH_TEMPLATES: readonly WorkbenchTemplate[] = [
  {
    id: 'projects',
    label: 'Project management workbench',
    description: 'Active, planned, and paused projects in one portfolio view',
    cards: [
      { recipeId: 'projects.active', layout: { x: 0, y: 0, w: 12, h: 4 } },
      { recipeId: 'projects.planning', layout: { x: 0, y: 4, w: 6, h: 4 } },
      { recipeId: 'projects.on_hold', layout: { x: 6, y: 4, w: 6, h: 4 } },
    ],
    requiredToolIds: ['project_query'],
    requiredApplicationIds: ['projects'],
  },
];

export interface WorkbenchTemplateAccess {
  readableToolIds: ReadonlySet<string> | readonly string[];
  visibleApplicationIds: ReadonlySet<string> | readonly string[];
}

/** Permission-filtered templates for either the browser or the Agent tool. */
export function availableWorkbenchTemplates(access: WorkbenchTemplateAccess): WorkbenchTemplate[] {
  const readable = access.readableToolIds instanceof Set ? access.readableToolIds : new Set(access.readableToolIds);
  const visibleApps =
    access.visibleApplicationIds instanceof Set ? access.visibleApplicationIds : new Set(access.visibleApplicationIds);
  return WORKBENCH_TEMPLATES.filter(
    (template) =>
      template.requiredToolIds.every((toolId) => readable.has(toolId)) &&
      template.requiredApplicationIds.every((appId) => visibleApps.has(appId)),
  );
}

export function findWorkbenchTemplate(templateId: string | undefined): WorkbenchTemplate | undefined {
  return templateId ? WORKBENCH_TEMPLATES.find((template) => template.id === templateId) : undefined;
}

export interface InstantiatedWorkbenchTemplate {
  tabs: WorkbenchTab[];
  widgets: WorkbenchWidget[];
}

/**
 * Turn a curated template into the same ordinary cards the editor creates.
 * Stable ids make repeated switches idempotent; the whole template is replaced
 * atomically, so no template identity needs to be persisted in the config.
 */
export function instantiateWorkbenchTemplate(
  templateId: string,
  titleForRecipe: (recipe: WidgetRecipe) => string = (recipe) => recipe.label,
): InstantiatedWorkbenchTemplate | null {
  const template = findWorkbenchTemplate(templateId);
  if (!template) return null;

  const widgets: WorkbenchWidget[] = [];
  for (const [index, card] of template.cards.entries()) {
    const recipe = findRecipe(card.recipeId);
    if (!recipe) return null;
    widgets.push({
      kind: 'data',
      id: `tpl_${template.id}_${index + 1}`,
      title: titleForRecipe(recipe).slice(0, WORKBENCH_LIMITS.maxTitleLength),
      layout: { tabId: DEFAULT_TAB_ID, ...card.layout },
      display: recipe.display,
      ...(recipe.chartType ? { chartType: recipe.chartType } : {}),
      source: { toolId: recipe.source.toolId, input: { ...recipe.source.input } },
      ...(recipe.map
        ? {
            map: {
              ...recipe.map,
              ...(recipe.map.y ? { y: [...recipe.map.y] } : {}),
              ...(recipe.map.columns ? { columns: recipe.map.columns.map((column) => ({ ...column })) } : {}),
            },
          }
        : {}),
      recipeId: recipe.id,
    });
  }
  return { tabs: [], widgets };
}

// ─── Batch evaluation wire types ─────────────────────────

/**
 * A card is always addressed by its stored id. There is deliberately no inline
 * variant: an unsaved source in the request body would be a second way into the
 * executor, and nothing in the product composes one.
 */
export type WorkbenchQueryRequest = { widgetId: string };

export type WorkbenchQueryFailure = 'forbidden' | 'not_found' | 'invalid' | 'failed';

export interface WorkbenchNavResolution {
  exists: boolean;
  allowed: boolean;
  /** Current title when the server could read one — otherwise the card's own. */
  title?: string;
}

export type WorkbenchQueryResult =
  | { index: number; ok: true; data: unknown }
  | { index: number; ok: true; nav: WorkbenchNavResolution }
  | { index: number; ok: false; error: WorkbenchQueryFailure; message?: string };

/**
 * Read a dot path out of a tool result. Returns undefined for any miss.
 *
 * Numeric segments index arrays (`rows.0.value`), which is what a KPI card
 * needs to read a single aggregate out of a one-row result. Still just
 * addressing — no slicing, filtering or arithmetic.
 */
export function readPath(source: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (Array.isArray(current)) {
      const index = /^[0-9]+$/.test(segment) ? Number(segment) : -1;
      if (index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

// ─── Relative date tokens ────────────────────────────────

/**
 * Saved queries need relative windows: a card literally storing `2026-08-04`
 * is wrong tomorrow. These tokens are expanded at evaluation time, server-side.
 *
 * Deliberately a fixed vocabulary rather than an expression language — the
 * point is that a stored config stays inert data.
 *
 *   $today            $yesterday
 *   $today-<N>d       1..365 days back from today
 *   $month_start      first day of the current month
 */
const DATE_TOKEN_PATTERN = /^\$(today|yesterday|month_start|today-([0-9]{1,3})d)$/;

function toIsoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Expand one token, or return null when the string is not a date token. */
export function expandDateToken(value: string, today: Date): string | null {
  const match = DATE_TOKEN_PATTERN.exec(value.trim());
  if (!match) return null;
  const base = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (match[1] === 'today') return toIsoDay(base);
  if (match[1] === 'yesterday') {
    base.setUTCDate(base.getUTCDate() - 1);
    return toIsoDay(base);
  }
  if (match[1] === 'month_start') {
    base.setUTCDate(1);
    return toIsoDay(base);
  }
  const days = Number(match[2]);
  if (!Number.isFinite(days) || days < 1 || days > 365) return null;
  base.setUTCDate(base.getUTCDate() - days);
  return toIsoDay(base);
}

/** Expand date tokens recursively through the bounded JSON input tree. */
export function expandDateTokens(input: Record<string, unknown>, today: Date): Record<string, unknown> {
  const expand = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return expandDateToken(value, today) ?? value;
    // Tool inputs are already bounded by their zod schemas. The depth guard is
    // an additional defence for a malformed legacy JSON blob.
    if (depth >= 12) return value;
    if (Array.isArray(value)) return value.map((item) => expand(item, depth + 1));
    if (isRecord(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, depth + 1)]));
    }
    return value;
  };
  return expand(input, 0) as Record<string, unknown>;
}
