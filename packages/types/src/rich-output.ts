/**
 * Shared Rich Output protocol and parser.
 *
 * This module is deliberately platform-free so Web and native clients apply
 * the same validation before model-authored blocks reach interactive
 * renderers. Unknown or invalid fences remain ordinary Markdown code blocks.
 */

// ─── Block Data Types ────────────────────────────────────

export type ChartType = 'bar' | 'line' | 'pie' | 'doughnut' | 'radar';

export interface ChartDataset {
  label: string;
  data: number[];
}

export interface ChartData {
  type: ChartType;
  title?: string;
  labels: string[];
  datasets: ChartDataset[];
}

export type ConfirmActionVariant = 'primary' | 'secondary' | 'destructive';

export interface ConfirmAction {
  label: string;
  value: string;
  variant?: ConfirmActionVariant;
}

export interface ConfirmData {
  text: string;
  actions: ConfirmAction[];
}

export type DataTableColumnType = 'text' | 'number' | 'currency' | 'percent' | 'boolean' | 'badge';

export interface DataTableColumn {
  key: string;
  label: string;
  type?: DataTableColumnType;
}

export interface DataTableData {
  title?: string;
  columns: DataTableColumn[];
  rows: Record<string, unknown>[];
}

/**
 * A button under a stats / cards / steps block. Pressing it sends `value` as the member's
 * next message — visibly, through the same path as typing it; nothing runs behind the user's
 * back. Same shape as a confirm action.
 */
export type BlockAction = ConfirmAction;

export type StatTrend = 'up' | 'down' | 'flat';
/** Colour, separate from direction: a rising cost is bad news. */
export type StatTone = 'positive' | 'negative' | 'neutral';

export interface StatItem {
  label: string;
  value: number | string;
  unit?: string;
  delta?: number | string;
  trend?: StatTrend;
  tone?: StatTone;
  hint?: string;
}

export interface StatsData {
  title?: string;
  items: StatItem[];
  actions?: BlockAction[];
}

export type CardBadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export interface CardItem {
  title: string;
  /** An in-app link (`#/projects/42`) or an http(s) URL — only ever a value a tool returned. */
  url?: string;
  subtitle?: string;
  badges?: Array<{ label: string; tone?: CardBadgeTone }>;
  fields?: Array<{ label: string; value: string }>;
}

export interface CardsData {
  title?: string;
  items: CardItem[];
  actions?: BlockAction[];
}

export type StepStatus = 'done' | 'active' | 'pending' | 'blocked' | 'skipped';

export interface StepItem {
  title: string;
  status: StepStatus;
  time?: string;
  detail?: string;
}

export interface StepsData {
  title?: string;
  items: StepItem[];
  actions?: BlockAction[];
}

/**
 * INPUTS — what the user attached to a turn. Two handle kinds coexist:
 *
 *   `id`  — a `chat_files` row (every conversation, the current path)
 *   `key` — a mission staging blob, which has no table, so the storage key IS
 *           the handle (written by the retired Mission feature; still parsed,
 *           because historical messages carry it, but no longer downloadable)
 *
 * Exactly one is set. An `id` downloads through an authenticated endpoint that
 * re-checks ownership; it is never a plain link.
 */
export interface ChatAttachmentItem {
  id?: string;
  key?: string;
  name: string;
  size_bytes?: number;
}

export type ChatAttachmentsData = ChatAttachmentItem[];

// ─── Fences a screen can draw ────────────────────────────

/** Blocks the model writes, in prompt order. Server-written fences (attachments) are not here. */
export type ModelFence = 'chart' | 'datatable' | 'stats' | 'cards' | 'steps' | 'confirm' | 'mermaid' | 'html-preview';

export const MODEL_FENCES: readonly ModelFence[] = [
  'chart',
  'datatable',
  'stats',
  'cards',
  'steps',
  'confirm',
  'mermaid',
  'html-preview',
];

/**
 * What a chat request that declares nothing (`rich_blocks` absent) can draw: exactly the five
 * blocks every client drew before capabilities existed, so an older client keeps today's
 * behaviour. New blocks are never added here — a client gets them only by declaring them.
 */
export const DEFAULT_CLIENT_BLOCKS: readonly ModelFence[] = [
  'chart',
  'datatable',
  'confirm',
  'mermaid',
  'html-preview',
];

/**
 * A chat request's `rich_blocks` → the blocks its screen draws. Not an array → undefined (use
 * {@link DEFAULT_CLIENT_BLOCKS}); unknown names are dropped silently, so a newer client talking
 * to an older server never fails its turn; `[]` = a screen that draws nothing special.
 */
export function admitRichBlocks(raw: unknown): ModelFence[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const declared = new Set(raw.filter((value): value is string => typeof value === 'string'));
  return MODEL_FENCES.filter((name) => declared.has(name));
}

// ─── Segments ────────────────────────────────────────────

/**
 * A Mermaid diagram, kept as SOURCE rather than parsed data.
 *
 * Every other fence carries JSON this module validates before a renderer sees
 * it. Mermaid's payload is its own DSL, so validation here would mean shipping
 * a second Mermaid parser — the renderer asks the real one and falls back to a
 * plain code block when it says no.
 */
export interface MermaidSegment {
  type: 'mermaid';
  code: string;
}

/**
 * A self-contained HTML document the user can preview.
 *
 * The fence is `html-preview`, NOT `html`, and the distinction is load-bearing:
 * ```html is what everyone writes when they want to *show* markup, so claiming
 * it would turn "give me the snippet to paste" into an un-copyable preview
 * card. A separate name makes the intent explicit and leaves ordinary code
 * blocks alone.
 *
 * Kept as source for the same reason as Mermaid — validating it here would mean
 * parsing HTML, and the renderer's isolation (opaque-origin iframe) is what
 * actually makes it safe, not a shape check.
 */
export interface HtmlPreviewSegment {
  type: 'html-preview';
  code: string;
  title?: string;
}

export interface MarkdownSegment {
  type: 'markdown';
  content: string;
}

export interface ChartSegment {
  type: 'chart';
  data: ChartData;
}

export interface ConfirmSegment {
  type: 'confirm';
  data: ConfirmData;
}

export interface DataTableSegment {
  type: 'datatable';
  data: DataTableData;
}

export interface DataTablePendingSegment {
  type: 'datatable-pending';
}

export interface ChatAttachmentsSegment {
  type: 'attachments';
  data: ChatAttachmentsData;
}

export interface StatsSegment {
  type: 'stats';
  data: StatsData;
}

export interface CardsSegment {
  type: 'cards';
  data: CardsData;
}

export interface StepsSegment {
  type: 'steps';
  data: StepsData;
}

export type Segment =
  | MarkdownSegment
  | ChartSegment
  | ConfirmSegment
  | DataTableSegment
  | DataTablePendingSegment
  | ChatAttachmentsSegment
  | StatsSegment
  | CardsSegment
  | StepsSegment
  | MermaidSegment
  | HtmlPreviewSegment;
/**
 * Fence names the parser accepts. Not simply the segment types: attachments are
 * written as ```attachments but every message the retired mission preset wrote
 * says ```mission-attachments, and those are read forever. Both land on the one
 * ChatAttachmentsSegment.
 */
export type KnownFenceBlock =
  | ChartSegment['type']
  | ConfirmSegment['type']
  | DataTableSegment['type']
  | ChatAttachmentsSegment['type']
  | StatsSegment['type']
  | CardsSegment['type']
  | StepsSegment['type']
  | MermaidSegment['type']
  | HtmlPreviewSegment['type']
  | 'mission-attachments';

/**
 * Resource limits for model-authored interactive blocks.
 *
 * They are intentionally well above a normal chat answer, while bounding the
 * amount of work a renderer can be asked to do from one fence.
 */
export const RICH_OUTPUT_LIMITS = {
  chartLabels: 2_000,
  chartDatasets: 32,
  chartPointsPerDataset: 2_000,
  dataTableColumns: 50,
  dataTableRows: 1_000,
  confirmActions: 20,
  /** Buttons under a stats / cards / steps block. */
  blockActions: 4,
  statsItems: 8,
  cardsItems: 20,
  cardBadges: 3,
  cardFields: 4,
  stepsItems: 20,
  attachmentFiles: 200,
  /** Mermaid source characters. Past this, layout cost stops being worth it and
   * the diagram stops being readable — show the source instead. */
  mermaidChars: 20_000,
  /** HTML preview characters. Well above a real single-file page, and bounded
   * so one fence cannot make the message itself unrenderable. */
  htmlPreviewChars: 400_000,
} as const;

const CHART_TYPES: ReadonlySet<string> = new Set<ChartType>(['bar', 'line', 'pie', 'doughnut', 'radar']);
const CONFIRM_VARIANTS: ReadonlySet<string> = new Set<ConfirmActionVariant>(['primary', 'secondary', 'destructive']);
const STAT_TRENDS: ReadonlySet<string> = new Set<StatTrend>(['up', 'down', 'flat']);
const STAT_TONES: ReadonlySet<string> = new Set<StatTone>(['positive', 'negative', 'neutral']);
const BADGE_TONES: ReadonlySet<string> = new Set<CardBadgeTone>([
  'neutral',
  'primary',
  'success',
  'warning',
  'danger',
  'info',
]);
const STEP_STATUSES: ReadonlySet<string> = new Set<StepStatus>(['done', 'active', 'pending', 'blocked', 'skipped']);

/**
 * Display-length caps for the stats / cards / steps text. Over-long text is cut with an
 * ellipsis rather than rejected: one wordy label must not turn a whole card list back into
 * raw JSON. Structure (types, counts) is still strict.
 */
const TEXT_LIMITS = {
  title: 60,
  label: 40,
  shortValue: 24,
  unit: 8,
  delta: 16,
  hint: 40,
  itemTitle: 80,
  subtitle: 120,
  badge: 16,
  fieldLabel: 16,
  fieldValue: 60,
  time: 24,
  detail: 200,
  actionLabel: 40,
  actionValue: 500,
} as const;

const DATA_TABLE_COLUMN_TYPES: ReadonlySet<string> = new Set<DataTableColumnType>([
  'text',
  'number',
  'currency',
  'percent',
  'boolean',
  'badge',
]);

// ─── Runtime Guards ──────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isChartDataset(value: unknown): value is ChartDataset {
  return (
    isRecord(value) &&
    typeof value.label === 'string' &&
    Array.isArray(value.data) &&
    value.data.length <= RICH_OUTPUT_LIMITS.chartPointsPerDataset &&
    value.data.every((point) => typeof point === 'number' && Number.isFinite(point))
  );
}

export function isChartData(value: unknown): value is ChartData {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    CHART_TYPES.has(value.type) &&
    isOptionalString(value.title) &&
    Array.isArray(value.labels) &&
    value.labels.length <= RICH_OUTPUT_LIMITS.chartLabels &&
    value.labels.every((label) => typeof label === 'string') &&
    Array.isArray(value.datasets) &&
    value.datasets.length <= RICH_OUTPUT_LIMITS.chartDatasets &&
    value.datasets.every(isChartDataset)
  );
}

function isConfirmAction(value: unknown): value is ConfirmAction {
  return (
    isRecord(value) &&
    typeof value.label === 'string' &&
    typeof value.value === 'string' &&
    (value.variant === undefined || (typeof value.variant === 'string' && CONFIRM_VARIANTS.has(value.variant)))
  );
}

export function isConfirmData(value: unknown): value is ConfirmData {
  return (
    isRecord(value) &&
    typeof value.text === 'string' &&
    Array.isArray(value.actions) &&
    value.actions.length > 0 &&
    value.actions.length <= RICH_OUTPUT_LIMITS.confirmActions &&
    value.actions.every(isConfirmAction)
  );
}

function isDataTableColumn(value: unknown): value is DataTableColumn {
  return (
    isRecord(value) &&
    typeof value.key === 'string' &&
    typeof value.label === 'string' &&
    (value.type === undefined || (typeof value.type === 'string' && DATA_TABLE_COLUMN_TYPES.has(value.type)))
  );
}

function hasOnlyFiniteDirectNumbers(row: Record<string, unknown>): boolean {
  return Object.values(row).every((value) => typeof value !== 'number' || Number.isFinite(value));
}

export function isDataTableData(value: unknown): value is DataTableData {
  return (
    isRecord(value) &&
    isOptionalString(value.title) &&
    Array.isArray(value.columns) &&
    value.columns.length <= RICH_OUTPUT_LIMITS.dataTableColumns &&
    value.columns.every(isDataTableColumn) &&
    Array.isArray(value.rows) &&
    value.rows.length <= RICH_OUTPUT_LIMITS.dataTableRows &&
    value.rows.every((row) => isRecord(row) && hasOnlyFiniteDirectNumbers(row))
  );
}

function isChatAttachment(value: unknown): value is ChatAttachmentItem {
  const handle = (v: unknown) => typeof v === 'string' && v.length > 0;
  return (
    isRecord(value) &&
    // Exactly one handle kind — neither is unresolvable, both is ambiguous
    // about which endpoint owns the bytes.
    handle(value.id) !== handle(value.key) &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    (value.size_bytes === undefined ||
      (typeof value.size_bytes === 'number' && Number.isFinite(value.size_bytes) && value.size_bytes >= 0))
  );
}

export function isChatAttachmentsData(value: unknown): value is ChatAttachmentsData {
  return Array.isArray(value) && value.length <= RICH_OUTPUT_LIMITS.attachmentFiles && value.every(isChatAttachment);
}

// ─── Parser ──────────────────────────────────────────────

/**
 * Parse Markdown into alternating plain-Markdown and interactive Rich Output
 * segments. Unknown fence languages pass through unchanged.
 */
export function parseSegments(markdown: string): Segment[] {
  if (!markdown) return [{ type: 'markdown', content: '' }];

  const segments: Segment[] = [];
  const regex =
    /```(chart|confirm|datatable|stats|cards|steps|mission-attachments|attachments|mermaid|html-preview)\s*\n([\s\S]*?)```/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(markdown)) !== null) {
    if (match.index > lastIndex) {
      appendMarkdownSegment(segments, markdown.slice(lastIndex, match.index));
    }

    const blockType = match[1] as KnownFenceBlock;
    const rawPayload = match[2] ?? '';
    const rawJson = rawPayload.trim();

    try {
      segments.push(parseBlockSegment(blockType, rawJson));
    } catch {
      segments.push({
        type: 'markdown',
        content: '```' + blockType + '\n' + rawPayload + '```',
      });
    }

    lastIndex = match.index + match[0].length;
  }

  // Streaming datatables reserve stable space as soon as their opening fence
  // is visible, without exposing partial JSON. Other open fences retain normal
  // Markdown behavior until they close.
  if (lastIndex < markdown.length) {
    const trailing = markdown.slice(lastIndex);
    const pendingDataTable = /```datatable[^\S\r\n]*\r?\n[\s\S]*$/.exec(trailing);
    if (pendingDataTable) {
      appendMarkdownSegment(segments, trailing.slice(0, pendingDataTable.index));
      segments.push({ type: 'datatable-pending' });
    } else {
      appendMarkdownSegment(segments, trailing);
    }
  }

  if (segments.length === 0) {
    return [{ type: 'markdown', content: markdown }];
  }

  return segments;
}

/**
 * User bubbles deliberately do not run the general Rich Output parser. Extract
 * only the attachment fence the server writes there and leave all other
 * Markdown byte-identical.
 */
export function splitAttachments(content: string): {
  text: string;
  attachments: ChatAttachmentsData;
} {
  // `mission-attachments` is the historical name, present in every message the
  // mission preset ever wrote — read forever, never written.
  if (!content.includes('```attachments') && !content.includes('```mission-attachments')) {
    return { text: content, attachments: [] };
  }

  const attachments: ChatAttachmentsData = [];
  const text = content
    .replace(/```(?:mission-)?attachments\s*\n([\s\S]*?)```/g, (whole, rawJson: string) => {
      try {
        attachments.push(...toChatAttachmentsData(JSON.parse(rawJson.trim())));
        return '';
      } catch {
        return whole; // malformed → leave it visible rather than silently eaten
      }
    })
    .trimEnd();
  return { text, attachments };
}

/**
 * Best-effort label from the document's own `<title>`, so the preview card and
 * the pane header say what the page is instead of "HTML preview".
 *
 * A regex rather than a parser on purpose: this runs in the shared, DOM-free
 * protocol module, and the value is only ever displayed as text.
 */
function extractHtmlTitle(html: string): { title: string } | null {
  const match = /<title[^>]*>([\s\S]{1,200}?)<\/title>/i.exec(html);
  const title = match?.[1]?.replace(/\s+/g, ' ').trim();
  return title ? { title } : null;
}

function appendMarkdownSegment(segments: Segment[], content: string): void {
  if (!content.trim()) return;
  segments.push({ type: 'markdown', content });
}

function parseBlockSegment(
  blockType: KnownFenceBlock,
  rawJson: string,
):
  | ChartSegment
  | ConfirmSegment
  | DataTableSegment
  | ChatAttachmentsSegment
  | StatsSegment
  | CardsSegment
  | StepsSegment
  | MermaidSegment
  | HtmlPreviewSegment {
  // Mermaid short-circuits every JSON path below: its payload is diagram source.
  if (blockType === 'mermaid') {
    if (!rawJson) throw new Error('mermaid payload is empty');
    if (rawJson.length > RICH_OUTPUT_LIMITS.mermaidChars) throw new Error('mermaid payload is too large');
    return { type: 'mermaid', code: rawJson };
  }
  // Likewise HTML: the payload is a document, and isolating it at render time
  // is the safety property — not anything this parser could check.
  if (blockType === 'html-preview') {
    if (!rawJson) throw new Error('html-preview payload is empty');
    if (rawJson.length > RICH_OUTPUT_LIMITS.htmlPreviewChars) throw new Error('html-preview payload is too large');
    return { type: 'html-preview', code: rawJson, ...(extractHtmlTitle(rawJson) ?? {}) };
  }
  // LLMs sometimes emit duplicate JSON keys such as a valid `rows` followed by
  // an accidental empty `rows`. Preserve the long-standing repair for that
  // specific trailing duplicate before parsing.
  const sanitized = blockType === 'datatable' ? rawJson.replace(/,\s*"rows"\s*:\s*\[\s*\]\s*(?=\}\s*$)/, '') : rawJson;
  const parsed: unknown = JSON.parse(sanitized);
  if (blockType === 'attachments' || blockType === 'mission-attachments') {
    return { type: 'attachments', data: toChatAttachmentsData(parsed) };
  }
  if (!isRecord(parsed)) throw new Error(`${blockType} payload is not an object`);

  switch (blockType) {
    case 'datatable':
      return { type: blockType, data: toDataTableData(parsed) };
    case 'chart':
      return { type: blockType, data: toChartData(parsed) };
    case 'confirm':
      return { type: blockType, data: toConfirmData(parsed) };
    case 'stats':
      return { type: blockType, data: toStatsData(parsed) };
    case 'cards':
      return { type: blockType, data: toCardsData(parsed) };
    case 'steps':
      return { type: blockType, data: toStepsData(parsed) };
  }
}

/**
 * Columns form a table's skeleton. Missing/non-array rows still normalize to
 * an empty table so an abandoned model answer remains renderable.
 */
function toDataTableData(payload: Record<string, unknown>): DataTableData {
  const normalized = {
    ...(typeof payload.title === 'string' ? { title: payload.title } : {}),
    columns: payload.columns,
    rows: (Array.isArray(payload.rows) ? payload.rows : []).filter(isRecord),
  };
  if (!isDataTableData(normalized)) {
    throw new Error('datatable payload is not renderable');
  }
  return normalized;
}

function toChartData(payload: Record<string, unknown>): ChartData {
  const normalized = {
    type: payload.type,
    ...(typeof payload.title === 'string' ? { title: payload.title } : {}),
    labels: payload.labels,
    datasets: payload.datasets,
  };
  if (!isChartData(normalized)) {
    throw new Error('chart payload is not renderable');
  }
  return normalized;
}

function toConfirmData(payload: Record<string, unknown>): ConfirmData {
  const normalized = {
    text: payload.text,
    actions: payload.actions,
  };
  if (!isConfirmData(normalized)) {
    throw new Error('confirm payload is not renderable');
  }
  return normalized;
}

function toChatAttachmentsData(payload: unknown): ChatAttachmentsData {
  if (!Array.isArray(payload)) {
    throw new Error('attachments payload must be an array');
  }
  const normalized = payload.filter(isChatAttachment);
  if (normalized.length > RICH_OUTPUT_LIMITS.attachmentFiles) {
    throw new Error('attachments payload is too large');
  }
  return normalized;
}

// ─── Stats / cards / steps (ported from v2) ──────────────

function fail(message: string): never {
  throw new Error(message);
}

/** Trimmed text cut to its display cap, or undefined when absent / empty. */
function clipText(value: unknown, max: number): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function requireText(value: unknown, max: number, what: string): string {
  return clipText(value, max) ?? fail(`${what} is required`);
}

function optionalText(key: string, value: unknown, max: number): Record<string, string> {
  const text = clipText(value, max);
  return text === undefined ? {} : { [key]: text };
}

function oneOf<T extends string>(value: unknown, allowed: ReadonlySet<string>): T | undefined {
  return typeof value === 'string' && allowed.has(value) ? (value as T) : undefined;
}

/** A bounded list of records; anything that is not a record fails the block. */
function itemsOf(value: unknown, max: number, what: string, min = 1): Record<string, unknown>[] {
  if (!Array.isArray(value)) fail(`${what} must be an array`);
  if (value.length < min) fail(`${what} is empty`);
  if (value.length > max) fail(`${what} has more than ${max} entries`);
  if (!value.every(isRecord)) fail(`${what} entries must be objects`);
  return value;
}

function toBlockActions(value: unknown): { actions?: BlockAction[] } {
  if (value === undefined) return {};
  const actions = itemsOf(value, RICH_OUTPUT_LIMITS.blockActions, 'actions', 0).map((action) => {
    const variant = oneOf<ConfirmActionVariant>(action.variant, CONFIRM_VARIANTS);
    return {
      label: requireText(action.label, TEXT_LIMITS.actionLabel, 'action label'),
      value: requireText(action.value, TEXT_LIMITS.actionValue, 'action value'),
      ...(variant ? { variant } : {}),
    };
  });
  return actions.length ? { actions } : {};
}

function toStatsData(payload: Record<string, unknown>): StatsData {
  const items = itemsOf(payload.items, RICH_OUTPUT_LIMITS.statsItems, 'stats items').map((item): StatItem => {
    const value =
      typeof item.value === 'number'
        ? Number.isFinite(item.value)
          ? item.value
          : fail('stat value is not finite')
        : requireText(item.value, TEXT_LIMITS.shortValue, 'stat value');
    const delta =
      typeof item.delta === 'number' && Number.isFinite(item.delta)
        ? { delta: item.delta }
        : optionalText('delta', item.delta, TEXT_LIMITS.delta);
    const trend = oneOf<StatTrend>(item.trend, STAT_TRENDS);
    const tone = oneOf<StatTone>(item.tone, STAT_TONES);
    return {
      label: requireText(item.label, TEXT_LIMITS.label, 'stat label'),
      value,
      ...optionalText('unit', item.unit, TEXT_LIMITS.unit),
      ...delta,
      ...(trend ? { trend } : {}),
      ...(tone ? { tone } : {}),
      ...optionalText('hint', item.hint, TEXT_LIMITS.hint),
    };
  });
  return { ...optionalText('title', payload.title, TEXT_LIMITS.title), items, ...toBlockActions(payload.actions) };
}

/** Only an in-app route or an http(s) URL — never `javascript:`, `data:` or a relative path. */
function toCardUrl(value: unknown): { url?: string } {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'string') fail('card url must be a string');
  const url = value.trim();
  if (/^#\/[^\s]+$/.test(url) || /^https?:\/\/[^\s]+$/i.test(url)) return { url };
  return fail('card url must be an in-app #/ route or an http(s) URL');
}

function toCardsData(payload: Record<string, unknown>): CardsData {
  const items = itemsOf(payload.items, RICH_OUTPUT_LIMITS.cardsItems, 'cards items').map((item): CardItem => {
    const badges =
      item.badges === undefined
        ? []
        : itemsOf(item.badges, RICH_OUTPUT_LIMITS.cardBadges, 'card badges', 0).map((badge) => {
            const tone = oneOf<CardBadgeTone>(badge.tone, BADGE_TONES);
            return { label: requireText(badge.label, TEXT_LIMITS.badge, 'badge label'), ...(tone ? { tone } : {}) };
          });
    const fields =
      item.fields === undefined
        ? []
        : itemsOf(item.fields, RICH_OUTPUT_LIMITS.cardFields, 'card fields', 0).map((field) => ({
            label: requireText(field.label, TEXT_LIMITS.fieldLabel, 'field label'),
            value: requireText(field.value, TEXT_LIMITS.fieldValue, 'field value'),
          }));
    return {
      title: requireText(item.title, TEXT_LIMITS.itemTitle, 'card title'),
      ...toCardUrl(item.url),
      ...optionalText('subtitle', item.subtitle, TEXT_LIMITS.subtitle),
      ...(badges.length ? { badges } : {}),
      ...(fields.length ? { fields } : {}),
    };
  });
  return { ...optionalText('title', payload.title, TEXT_LIMITS.title), items, ...toBlockActions(payload.actions) };
}

function toStepsData(payload: Record<string, unknown>): StepsData {
  const items = itemsOf(payload.items, RICH_OUTPUT_LIMITS.stepsItems, 'steps items').map(
    (item): StepItem => ({
      title: requireText(item.title, TEXT_LIMITS.itemTitle, 'step title'),
      status: oneOf<StepStatus>(item.status, STEP_STATUSES) ?? fail('step status is not recognised'),
      ...optionalText('time', item.time, TEXT_LIMITS.time),
      ...optionalText('detail', item.detail, TEXT_LIMITS.detail),
    }),
  );
  return { ...optionalText('title', payload.title, TEXT_LIMITS.title), items, ...toBlockActions(payload.actions) };
}

/**
 * Which button of a block was pressed: the member's next message, when it is one of the
 * block's values (surrounding whitespace aside). One rule for every client, so a reload, or
 * another device, shows the same choice.
 */
export function resolveBlockAction(
  actions: readonly BlockAction[] | undefined,
  followUp: string | null | undefined,
): string | null {
  if (!actions || followUp == null) return null;
  const sent = followUp.trim();
  return actions.find((action) => action.value === sent)?.value ?? null;
}

// ─── Plain-Markdown stand-ins ────────────────────────────
//
// For every place a stats / cards / steps block cannot be drawn: email and IM deliveries,
// copy as text, a client that did not declare the block. Buttons are left out — they only
// work where the block is drawn.

/** How a step that is not simply done / to do reads ("in progress", "blocked"…). */
export type StepStatusWords = (status: StepStatus) => string;

export const DEFAULT_STEP_STATUS_WORDS: StepStatusWords = (status) =>
  ({ done: 'done', active: 'in progress', pending: 'to do', blocked: 'blocked', skipped: 'skipped' })[status];

/** Link text that cannot close the link early: `[`, `]` and backslashes escaped. */
function markdownLinkText(text: string): string {
  return text.replace(/[\\[\]]/g, '\\$&');
}

/** A destination that cannot end the link early: `(`, `)`, `<`, `>` and spaces percent-encoded. */
function markdownLinkUrl(url: string): string {
  return url.replace(/[()<>\s]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

function titled(title: string | undefined, body: string): string {
  return [title ? `**${title}**` : '', body].filter(Boolean).join('\n\n');
}

export function statsMarkdown(data: StatsData): string {
  const lines = data.items.map((item) => {
    const value = [String(item.value), item.unit].filter(Boolean).join(' ');
    const extra = [item.delta === undefined ? undefined : String(item.delta), item.hint].filter(Boolean).join(', ');
    return `- **${item.label}**: ${value}${extra ? ` (${extra})` : ''}`;
  });
  return titled(data.title, lines.join('\n'));
}

export function cardsMarkdown(data: CardsData): string {
  const lines = data.items.map((item) => {
    const head = item.url ? `[${markdownLinkText(item.title)}](${markdownLinkUrl(item.url)})` : `**${item.title}**`;
    const tail = [
      item.subtitle,
      ...(item.badges ?? []).map((badge) => badge.label),
      ...(item.fields ?? []).map((field) => `${field.label} ${field.value}`),
    ].filter(Boolean);
    return `- ${head}${tail.length ? ` — ${tail.join(' · ')}` : ''}`;
  });
  return titled(data.title, lines.join('\n'));
}

/** A GFM task list: done ticks, everything else is open and says its state. */
export function stepsMarkdown(data: StepsData, words: StepStatusWords = DEFAULT_STEP_STATUS_WORDS): string {
  const lines = data.items.map((item) => {
    const box = item.status === 'done' ? '[x]' : '[ ]';
    const state = item.status === 'done' || item.status === 'pending' ? '' : words(item.status);
    const meta = [item.time, state].filter(Boolean).join(', ');
    return `- ${box} ${item.title}${meta ? ` (${meta})` : ''}${item.detail ? ` — ${item.detail}` : ''}`;
  });
  return titled(data.title, lines.join('\n'));
}
