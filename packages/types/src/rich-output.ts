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

export interface MissionArtifactsSegment {
  type: 'mission-artifacts';
  data: MissionArtifactsData;
}

export interface ChatAttachmentsSegment {
  type: 'attachments';
  data: ChatAttachmentsData;
}

export type Segment =
  | MarkdownSegment
  | ChartSegment
  | ConfirmSegment
  | DataTableSegment
  | DataTablePendingSegment
  | MissionArtifactsSegment
  | ChatAttachmentsSegment
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
  | MissionArtifactsSegment['type']
  | ChatAttachmentsSegment['type']
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

// ─── Parser ──────────────────────────────────────────────

/**
 * Parse Markdown into alternating plain-Markdown and interactive Rich Output
 * segments. Unknown fence languages pass through unchanged.
 */
export function parseSegments(markdown: string): Segment[] {
  if (!markdown) return [{ type: 'markdown', content: '' }];

  const segments: Segment[] = [];
  const regex =
    /```(chart|confirm|datatable|mission-artifacts|mission-attachments|attachments|mermaid|html-preview)\s*\n([\s\S]*?)```/g;

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
  | MissionArtifactsSegment
  | ChatAttachmentsSegment
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
  if (blockType === 'mission-artifacts') {
    return { type: blockType, data: toMissionArtifactsData(parsed) };
  }
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

function toMissionArtifactsData(payload: unknown): MissionArtifactsData {
  if (!Array.isArray(payload)) {
    throw new Error('mission-artifacts payload must be an array');
  }
  const normalized = payload.filter(isMissionArtifact);
  if (normalized.length > RICH_OUTPUT_LIMITS.missionFiles) {
    throw new Error('mission-artifacts payload is too large');
  }
  return normalized;
}

function toChatAttachmentsData(payload: unknown): ChatAttachmentsData {
  if (!Array.isArray(payload)) {
    throw new Error('attachments payload must be an array');
  }
  const normalized = payload.filter(isChatAttachment);
  if (normalized.length > RICH_OUTPUT_LIMITS.missionFiles) {
    throw new Error('attachments payload is too large');
  }
  return normalized;
}
