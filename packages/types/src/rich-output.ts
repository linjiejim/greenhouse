/**
 * Shared Rich Output protocol, block registry and parser.
 *
 * This module is deliberately platform-free so Web and native clients apply
 * the same validation before model-authored blocks reach interactive
 * renderers. Unknown or invalid fences remain ordinary Markdown code blocks.
 *
 * Every block is registered ONCE in {@link RICH_BLOCKS}. The parser, the
 * streaming placeholder, the interrupted-turn trimming on persist, the
 * plain-Markdown stand-in (email / IM / copy / export / a client that cannot
 * draw the block) and the diagnosis behind `pnpm cli rich-output stats` all
 * derive from that one entry (spec docs/specs/20261008-rich-output-foundation.md).
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

/** A Cloud Agent deliverable exposed through its authenticated download route. */
export interface MissionArtifactItem {
  id: number;
  run_id: string;
  path: string;
  size_bytes?: number;
  content_type?: string;
}

export type MissionArtifactsData = MissionArtifactItem[];

/**
 * INPUTS — what the user attached to a turn. Two handle kinds coexist:
 *
 *   `id`  — a `chat_files` row (every conversation, the current path)
 *   `key` — a mission staging blob, which has no table, so the storage key IS
 *           the handle (written by the retired `sprouty-mission` preset; read
 *           forever, because historical messages carry it)
 *
 * Exactly one is set. Both download through an authenticated endpoint that
 * re-checks ownership; neither is ever a plain link.
 */
export interface ChatAttachmentItem {
  id?: string;
  key?: string;
  name: string;
  size_bytes?: number;
}

export type ChatAttachmentsData = ChatAttachmentItem[];

// ─── Fences ──────────────────────────────────────────────

/** Blocks the model writes: taught in the prompt, gated by the client's declared capabilities. */
export type ModelFence = 'chart' | 'datatable' | 'confirm' | 'mermaid' | 'html-preview';
/** Blocks only the server writes: never taught, but every client must at least degrade them. */
export type ServerFence = 'mission-artifacts' | 'attachments';
export type RichFence = ModelFence | ServerFence;

/** Every model-authored block, in prompt order. */
export const MODEL_FENCES: readonly ModelFence[] = ['chart', 'datatable', 'confirm', 'mermaid', 'html-preview'];

/**
 * What a request that declares nothing is taught — exactly the five blocks
 * every client could draw before capabilities existed, so an old client keeps
 * today's behaviour. New blocks are NEVER added here: a client learns them only
 * by declaring them (spec D2).
 */
export const DEFAULT_CLIENT_BLOCKS: readonly ModelFence[] = [
  'chart',
  'datatable',
  'confirm',
  'mermaid',
  'html-preview',
];

/**
 * Turn a request's `rich_blocks` into the blocks to teach.
 *
 * Not an array → `undefined` (teach {@link DEFAULT_CLIENT_BLOCKS}). An array is
 * intersected with the known names, unknown entries dropped silently — a newer
 * client talking to an older server must not fail its turn. `[]` means a
 * client that draws nothing special.
 */
export function admitRichBlocks(raw: unknown): ModelFence[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const declared = new Set(raw.filter((value): value is string => typeof value === 'string'));
  return MODEL_FENCES.filter((fence) => declared.has(fence));
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

/**
 * A registered fence that has opened but not closed yet — the model is still
 * writing it. Renderers reserve stable space instead of exposing half a JSON
 * payload or half an HTML document.
 */
export interface PendingSegment {
  type: 'pending';
  fence: RichFence;
}

export interface MissionArtifactsSegment {
  type: 'mission-artifacts';
  data: MissionArtifactsData;
}

export interface ChatAttachmentsSegment {
  type: 'attachments';
  data: ChatAttachmentsData;
}

/** A validated block — one per registered fence; `type` is the fence name. */
export type BlockSegment =
  | ChartSegment
  | ConfirmSegment
  | DataTableSegment
  | MissionArtifactsSegment
  | ChatAttachmentsSegment
  | MermaidSegment
  | HtmlPreviewSegment;

export type Segment = MarkdownSegment | PendingSegment | BlockSegment;

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
  missionFiles: 200,
  /** Mermaid source characters. Past this, layout cost stops being worth it and
   * the diagram stops being readable — show the source instead. */
  mermaidChars: 20_000,
  /** HTML preview characters. Well above a real single-file page, and bounded
   * so one fence cannot make the message itself unrenderable. */
  htmlPreviewChars: 400_000,
} as const;

const CHART_TYPES: ReadonlySet<string> = new Set<ChartType>(['bar', 'line', 'pie', 'doughnut', 'radar']);
const CONFIRM_VARIANTS: ReadonlySet<string> = new Set<ConfirmActionVariant>(['primary', 'secondary', 'destructive']);
const DATA_TABLE_COLUMN_TYPES: ReadonlySet<string> = new Set<DataTableColumnType>([
  'text',
  'number',
  'currency',
  'percent',
  'boolean',
  'badge',
]);

// ─── Failures ────────────────────────────────────────────

/** Why a closed fence fell back to a code block (`pnpm cli rich-output stats`). */
export type RichBlockFailure = 'json' | 'shape' | 'too_large' | 'empty';

export class RichBlockError extends Error {
  readonly reason: RichBlockFailure;

  constructor(reason: RichBlockFailure, message: string) {
    super(message);
    this.name = 'RichBlockError';
    this.reason = reason;
  }
}

function fail(reason: RichBlockFailure, message: string): never {
  throw new RichBlockError(reason, message);
}

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

function isMissionArtifact(value: unknown): value is MissionArtifactItem {
  return (
    isRecord(value) &&
    typeof value.id === 'number' &&
    Number.isInteger(value.id) &&
    typeof value.run_id === 'string' &&
    value.run_id.length > 0 &&
    typeof value.path === 'string' &&
    value.path.length > 0 &&
    (value.size_bytes === undefined ||
      (typeof value.size_bytes === 'number' && Number.isFinite(value.size_bytes) && value.size_bytes >= 0)) &&
    isOptionalString(value.content_type)
  );
}

export function isMissionArtifactsData(value: unknown): value is MissionArtifactsData {
  return Array.isArray(value) && value.length <= RICH_OUTPUT_LIMITS.missionFiles && value.every(isMissionArtifact);
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
  return Array.isArray(value) && value.length <= RICH_OUTPUT_LIMITS.missionFiles && value.every(isChatAttachment);
}

// ─── Payload parsing ─────────────────────────────────────

function parseJson(body: string): unknown {
  if (!body) fail('empty', 'payload is empty');
  try {
    return JSON.parse(body);
  } catch {
    return fail('json', 'payload is not valid JSON');
  }
}

function parseJsonObject(body: string, fence: string): Record<string, unknown> {
  const parsed = parseJson(body);
  if (!isRecord(parsed)) fail('shape', `${fence} payload is not an object`);
  return parsed;
}

/** A finite number, or a numeric string the model quoted by mistake. */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Strict: one point the renderer cannot plot invalidates the series. */
function toSeries(values: unknown[]): number[] {
  return values.map((value) => toFiniteNumber(value) ?? fail('shape', 'chart point is not a finite number'));
}

/**
 * Normalize the chart shapes models actually write into the canonical
 * Chart.js-style spec the prompt teaches.
 *
 * The canonical form is `{ type, title?, labels, datasets: [{ label, data }] }`.
 * Two loose forms are accepted too — they used to be a mobile-only leniency,
 * which meant the two clients disagreed on the same message:
 *   - `data: [{ label|name|x, value|y|count }]` → one series
 *   - `labels|categories` + parallel `values|series|data` arrays → one series
 * An unknown or missing `type` draws as a bar chart. A non-numeric point is
 * still invalid: a silently zeroed value would be a wrong chart, not a lenient one.
 */
function toChartData(payload: Record<string, unknown>): ChartData {
  const type = (typeof payload.type === 'string' && CHART_TYPES.has(payload.type) ? payload.type : 'bar') as ChartType;
  const title = typeof payload.title === 'string' ? payload.title : undefined;
  const rawLabels = Array.isArray(payload.labels)
    ? payload.labels
    : Array.isArray(payload.categories)
      ? payload.categories
      : [];
  let labels = rawLabels.map((label) => (typeof label === 'string' ? label : String(label)));
  let datasets: ChartDataset[] = [];

  if (Array.isArray(payload.datasets)) {
    if (payload.datasets.length > RICH_OUTPUT_LIMITS.chartDatasets) fail('too_large', 'chart has too many datasets');
    datasets = payload.datasets
      .map((dataset) => {
        if (!isRecord(dataset) || !Array.isArray(dataset.data)) return fail('shape', 'chart dataset has no data array');
        if (dataset.data.length > RICH_OUTPUT_LIMITS.chartPointsPerDataset) {
          return fail('too_large', 'chart dataset has too many points');
        }
        return { label: typeof dataset.label === 'string' ? dataset.label : '', data: toSeries(dataset.data) };
      })
      .filter((dataset) => dataset.data.length > 0);
  } else {
    const data = Array.isArray(payload.data) ? payload.data : null;
    if (data && data.some(isRecord)) {
      const points = data.filter(isRecord).map((point) => ({
        label: String(point.label ?? point.name ?? point.x ?? ''),
        value: toFiniteNumber(point.value ?? point.y ?? point.count) ?? fail('shape', 'chart point has no value'),
      }));
      if (!labels.length) labels = points.map((point) => point.label);
      datasets = [{ label: title ?? '', data: points.map((point) => point.value) }];
    } else {
      const values = Array.isArray(payload.values)
        ? payload.values
        : Array.isArray(payload.series)
          ? payload.series
          : (data ?? []);
      if (values.length) datasets = [{ label: title ?? '', data: toSeries(values) }];
    }
  }

  if (!datasets.length) fail('shape', 'chart has no data');
  const points = Math.max(...datasets.map((dataset) => dataset.data.length));
  if (points > RICH_OUTPUT_LIMITS.chartPointsPerDataset) fail('too_large', 'chart has too many points');
  if (labels.length < points) labels = Array.from({ length: points }, (_, index) => labels[index] ?? String(index + 1));
  if (labels.length > RICH_OUTPUT_LIMITS.chartLabels) fail('too_large', 'chart has too many labels');

  const normalized: ChartData = { type, ...(title !== undefined ? { title } : {}), labels, datasets };
  if (!isChartData(normalized)) fail('shape', 'chart payload is not renderable');
  return normalized;
}

/**
 * Columns form a table's skeleton. Missing/non-array rows still normalize to
 * an empty table so an abandoned model answer remains renderable.
 */
function toDataTableData(payload: Record<string, unknown>): DataTableData {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (rows.length > RICH_OUTPUT_LIMITS.dataTableRows) fail('too_large', 'datatable has too many rows');
  if (Array.isArray(payload.columns) && payload.columns.length > RICH_OUTPUT_LIMITS.dataTableColumns) {
    fail('too_large', 'datatable has too many columns');
  }
  const normalized = {
    ...(typeof payload.title === 'string' ? { title: payload.title } : {}),
    columns: payload.columns,
    rows: rows.filter(isRecord),
  };
  if (!isDataTableData(normalized)) fail('shape', 'datatable payload is not renderable');
  return normalized;
}

function toConfirmData(payload: Record<string, unknown>): ConfirmData {
  if (Array.isArray(payload.actions) && payload.actions.length > RICH_OUTPUT_LIMITS.confirmActions) {
    fail('too_large', 'confirm has too many actions');
  }
  const normalized = { text: payload.text, actions: payload.actions };
  if (!isConfirmData(normalized)) fail('shape', 'confirm payload is not renderable');
  return normalized;
}

function toMissionArtifactsData(payload: unknown): MissionArtifactsData {
  if (!Array.isArray(payload)) fail('shape', 'mission-artifacts payload must be an array');
  const normalized = payload.filter(isMissionArtifact);
  if (normalized.length > RICH_OUTPUT_LIMITS.missionFiles) fail('too_large', 'mission-artifacts payload is too large');
  return normalized;
}

function toChatAttachmentsData(payload: unknown): ChatAttachmentsData {
  if (!Array.isArray(payload)) fail('shape', 'attachments payload must be an array');
  const normalized = payload.filter(isChatAttachment);
  if (normalized.length > RICH_OUTPUT_LIMITS.missionFiles) fail('too_large', 'attachments payload is too large');
  return normalized;
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

// ─── Plain-Markdown stand-ins ────────────────────────────

/**
 * What a surface that cannot draw a block shows instead. Every caller picks
 * its own wording: notification delivery says "open the conversation", the web
 * copy/export uses its i18n, a client without a renderer keeps the source.
 */
export interface FlattenNotes {
  /** A diagram that cannot be drawn here. */
  diagram(code: string): string;
  /** An HTML page that cannot be previewed here. */
  preview(segment: HtmlPreviewSegment): string;
  /** Buttons that cannot be pressed here. */
  confirm(data: ConfirmData): string;
  artifactsHeading: string;
  attachmentsHeading: string;
  boolean(value: boolean): string;
}

/** Keep what cannot be drawn as copyable source — the right default for a client. */
export const DEFAULT_FLATTEN_NOTES: FlattenNotes = {
  diagram: (code) => '```mermaid\n' + code + '\n```',
  preview: (segment) => '```html\n' + segment.code + '\n```',
  confirm: (data) =>
    [data.text.trim(), data.actions.map((action) => `- ${action.label}`).join('\n')].filter(Boolean).join('\n\n'),
  artifactsHeading: 'Files',
  attachmentsHeading: 'Attachments',
  boolean: (value) => (value ? 'true' : 'false'),
};

/** Newlines and pipes would break out of the cell and take the whole table with them. */
function tableCell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

/**
 * Values are rendered as written. The browser's `DataTableBlock` formats currency
 * and percent columns, but mirroring that here would be a second copy of a
 * formatter that is free to change — a stand-in is about the numbers, not their
 * presentation.
 */
function formatCell(value: unknown, notes: FlattenNotes): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return notes.boolean(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function markdownTable(data: DataTableData, notes: FlattenNotes): string {
  if (!data.columns.length) return '';
  const lines = [
    `| ${data.columns.map((column) => tableCell(column.label || column.key)).join(' | ')} |`,
    `| ${data.columns.map(() => '---').join(' | ')} |`,
    ...data.rows.map(
      (row) => `| ${data.columns.map((column) => tableCell(formatCell(row[column.key], notes))).join(' | ')} |`,
    ),
  ];
  const table = lines.join('\n');
  return data.title ? `**${data.title.trim()}**\n\n${table}` : table;
}

/**
 * A chart cannot be drawn everywhere, but the numbers behind it are the reason
 * the agent produced one — so it becomes the same table the chart was built from
 * rather than a "chart omitted" placeholder.
 */
function chartAsTable(data: ChartData, notes: FlattenNotes): string {
  return markdownTable(
    {
      title: data.title,
      columns: [
        { key: '', label: '' },
        ...data.datasets.map((dataset, index) => ({ key: String(index), label: dataset.label })),
      ],
      rows: data.labels.map((label, row) => ({
        '': label,
        ...Object.fromEntries(data.datasets.map((dataset, index) => [String(index), dataset.data[row]])),
      })),
    },
    notes,
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // `Number()` rather than the `toFixed` string, so 2048 reads "2 KB", not "2.0 KB".
  return `${unit === 0 || value >= 10 ? Math.round(value) : Number(value.toFixed(1))} ${units[unit]}`;
}

function fileList(heading: string, items: { name: string; sizeBytes?: number }[]): string {
  if (!items.length) return '';
  const rows = items.map((item) => {
    const size = item.sizeBytes === undefined ? '' : ` (${formatBytes(item.sizeBytes)})`;
    return `- ${item.name}${size}`;
  });
  return [`**${heading}**`, '', ...rows].join('\n');
}

// ─── Block registry ──────────────────────────────────────

export interface RichBlockDef<S extends BlockSegment = BlockSegment> {
  fence: RichFence;
  /** Historical names still read, never written. */
  aliases?: readonly string[];
  author: 'model' | 'server';
  /** Fence body → validated segment. Throws ({@link RichBlockError}) → ordinary code block. */
  parse(body: string): S;
  /** The plain-Markdown stand-in for a surface that cannot draw this block. */
  toMarkdown(segment: S, notes: FlattenNotes): string;
}

function defineBlock<S extends BlockSegment>(def: RichBlockDef<S>): RichBlockDef<S> {
  return def;
}

/** The one list of fences this protocol understands. Adding a block = adding an entry here. */
export const RICH_BLOCKS: readonly RichBlockDef[] = [
  defineBlock<ChartSegment>({
    fence: 'chart',
    author: 'model',
    parse: (body) => ({ type: 'chart', data: toChartData(parseJsonObject(body, 'chart')) }),
    toMarkdown: (segment, notes) => chartAsTable(segment.data, notes),
  }),
  defineBlock<DataTableSegment>({
    fence: 'datatable',
    author: 'model',
    parse: (body) =>
      // LLMs sometimes emit duplicate JSON keys such as a valid `rows` followed
      // by an accidental empty `rows`. Preserve the long-standing repair for
      // that specific trailing duplicate before parsing.
      ({
        type: 'datatable',
        data: toDataTableData(parseJsonObject(body.replace(/,\s*"rows"\s*:\s*\[\s*\]\s*(?=\}\s*$)/, ''), 'datatable')),
      }),
    toMarkdown: (segment, notes) => markdownTable(segment.data, notes),
  }),
  defineBlock<ConfirmSegment>({
    fence: 'confirm',
    author: 'model',
    parse: (body) => ({ type: 'confirm', data: toConfirmData(parseJsonObject(body, 'confirm')) }),
    toMarkdown: (segment, notes) => notes.confirm(segment.data),
  }),
  defineBlock<MermaidSegment>({
    fence: 'mermaid',
    author: 'model',
    // The payload is diagram source, not JSON.
    parse: (body) => {
      if (!body) fail('empty', 'mermaid payload is empty');
      if (body.length > RICH_OUTPUT_LIMITS.mermaidChars) fail('too_large', 'mermaid payload is too large');
      return { type: 'mermaid', code: body };
    },
    toMarkdown: (segment, notes) => notes.diagram(segment.code),
  }),
  defineBlock<HtmlPreviewSegment>({
    fence: 'html-preview',
    author: 'model',
    // Likewise HTML: the payload is a document, and isolating it at render
    // time is the safety property — not anything this parser could check.
    parse: (body) => {
      if (!body) fail('empty', 'html-preview payload is empty');
      if (body.length > RICH_OUTPUT_LIMITS.htmlPreviewChars) fail('too_large', 'html-preview payload is too large');
      return { type: 'html-preview', code: body, ...(extractHtmlTitle(body) ?? {}) };
    },
    toMarkdown: (segment, notes) => notes.preview(segment),
  }),
  defineBlock<MissionArtifactsSegment>({
    fence: 'mission-artifacts',
    author: 'server',
    parse: (body) => ({ type: 'mission-artifacts', data: toMissionArtifactsData(parseJson(body)) }),
    toMarkdown: (segment, notes) =>
      fileList(
        notes.artifactsHeading,
        segment.data.map((item) => ({ name: item.path, sizeBytes: item.size_bytes })),
      ),
  }),
  defineBlock<ChatAttachmentsSegment>({
    fence: 'attachments',
    // Attachments are written as ```attachments, but every message the retired
    // mission preset wrote says ```mission-attachments — read forever.
    aliases: ['mission-attachments'],
    author: 'server',
    parse: (body) => ({ type: 'attachments', data: toChatAttachmentsData(parseJson(body)) }),
    toMarkdown: (segment, notes) =>
      fileList(
        notes.attachmentsHeading,
        segment.data.map((item) => ({ name: item.name, sizeBytes: item.size_bytes })),
      ),
  }),
];

const BLOCK_BY_NAME: ReadonlyMap<string, RichBlockDef> = new Map(
  RICH_BLOCKS.flatMap((def) => [def.fence, ...(def.aliases ?? [])].map((name) => [name, def] as const)),
);

/** The registry entry for a fence name (aliases included). */
export function richBlock(name: string): RichBlockDef | undefined {
  return BLOCK_BY_NAME.get(name);
}

const FENCE_NAMES = [...BLOCK_BY_NAME.keys()]
  // Longest first, so no name can shadow a longer one that starts with it.
  .sort((left, right) => right.length - left.length)
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

/** A complete registered fence. */
const CLOSED_FENCE = new RegExp('```(' + FENCE_NAMES + ')\\s*\\n([\\s\\S]*?)```', 'g');
/** An opening registered fence — the start of a block that may not have closed. */
const OPEN_FENCE = new RegExp('```(' + FENCE_NAMES + ')[^\\S\\r\\n]*\\r?\\n', 'g');

// ─── Scanner ─────────────────────────────────────────────

type ScanToken =
  | { kind: 'text'; content: string }
  | { kind: 'block'; name: string; def: RichBlockDef; payload: string }
  | { kind: 'open'; def: RichBlockDef };

/** Split Markdown into text, complete registered fences and (at most one) trailing open fence. */
function scan(markdown: string): ScanToken[] {
  const tokens: ScanToken[] = [];
  const closed = new RegExp(CLOSED_FENCE.source, 'g');
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = closed.exec(markdown)) !== null) {
    if (match.index > lastIndex) tokens.push({ kind: 'text', content: markdown.slice(lastIndex, match.index) });
    const name = match[1] ?? '';
    tokens.push({ kind: 'block', name, def: BLOCK_BY_NAME.get(name)!, payload: match[2] ?? '' });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < markdown.length) {
    // Everything closed was consumed above, so a registered opening fence in
    // the tail is one the model is still writing.
    const trailing = markdown.slice(lastIndex);
    const open = new RegExp(OPEN_FENCE.source).exec(trailing);
    if (open) {
      tokens.push({ kind: 'text', content: trailing.slice(0, open.index) });
      tokens.push({ kind: 'open', def: BLOCK_BY_NAME.get(open[1] ?? '')! });
    } else {
      tokens.push({ kind: 'text', content: trailing });
    }
  }
  return tokens;
}

// ─── Parser ──────────────────────────────────────────────

/**
 * Parse Markdown into alternating plain-Markdown and interactive Rich Output
 * segments. Unknown fence languages pass through unchanged; a registered fence
 * that fails validation becomes an ordinary code block; a registered fence that
 * has not closed yet becomes a `pending` segment.
 */
export function parseSegments(markdown: string): Segment[] {
  if (!markdown) return [{ type: 'markdown', content: '' }];

  const segments: Segment[] = [];
  for (const token of scan(markdown)) {
    if (token.kind === 'text') {
      appendMarkdownSegment(segments, token.content);
    } else if (token.kind === 'open') {
      segments.push({ type: 'pending', fence: token.def.fence });
    } else {
      try {
        segments.push(token.def.parse(token.payload.trim()));
      } catch {
        segments.push({ type: 'markdown', content: '```' + token.name + '\n' + token.payload + '```' });
      }
    }
  }

  return segments.length ? segments : [{ type: 'markdown', content: markdown }];
}

function appendMarkdownSegment(segments: Segment[], content: string): void {
  if (!content.trim()) return;
  segments.push({ type: 'markdown', content });
}

/**
 * Where the first registered fence that never closed begins, or null.
 *
 * Persistence cuts an interrupted answer here so the stored message never ends
 * in half a block (which would otherwise render as a giant code block forever).
 */
export function findIncompleteRichBlock(content: string): number | null {
  const open = new RegExp(OPEN_FENCE.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = open.exec(content)) !== null) {
    const closing = content.indexOf('```', open.lastIndex);
    if (closing === -1) return match.index;
    open.lastIndex = closing + 3;
  }
  return null;
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

// ─── Flatten ─────────────────────────────────────────────

/** One validated block as plain Markdown. */
export function flattenSegment(segment: BlockSegment, notes: FlattenNotes = DEFAULT_FLATTEN_NOTES): string {
  return BLOCK_BY_NAME.get(segment.type)!.toMarkdown(segment, notes);
}

/** Agent output with every Rich Output fence turned into ordinary Markdown. */
export function flattenRichOutput(markdown: string, notes: FlattenNotes = DEFAULT_FLATTEN_NOTES): string {
  if (!markdown.trim()) return '';
  return parseSegments(markdown)
    .map((segment) => {
      if (segment.type === 'markdown') return segment.content.trim();
      // An unterminated fence: the turn was cut off before the block existed,
      // so there is nothing to show and no reason to mention it.
      if (segment.type === 'pending') return '';
      return flattenSegment(segment, notes);
    })
    .filter((part) => part.trim())
    .join('\n\n')
    .trim();
}

// ─── Diagnosis ───────────────────────────────────────────

export interface RichBlockDiagnosis {
  fence: RichFence;
  outcome: 'ok' | 'invalid' | 'unterminated';
  reason?: RichBlockFailure;
}

/**
 * Every registered fence in a message and whether it rendered — the data behind
 * `pnpm cli rich-output stats`. Protocol-level only: a Mermaid syntax error is
 * known only to the browser's Mermaid and counts as `ok` here.
 */
export function diagnoseRichOutput(markdown: string): RichBlockDiagnosis[] {
  const out: RichBlockDiagnosis[] = [];
  for (const token of scan(markdown)) {
    if (token.kind === 'open') {
      out.push({ fence: token.def.fence, outcome: 'unterminated' });
    } else if (token.kind === 'block') {
      try {
        token.def.parse(token.payload.trim());
        out.push({ fence: token.def.fence, outcome: 'ok' });
      } catch (error) {
        out.push({
          fence: token.def.fence,
          outcome: 'invalid',
          reason: error instanceof RichBlockError ? error.reason : 'shape',
        });
      }
    }
  }
  return out;
}
