/**
 * Block registry and segment parser.
 *
 * Parses markdown content into alternating segments:
 *   markdown text ↔ custom block (chart / confirm / datatable / local files)
 *
 * Unknown code fences pass through as normal markdown.
 */

// ─── Types ───────────────────────────────────────────────

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

export interface LocalFilesSegment {
  type: 'local-files';
  data: LocalFilesData;
}

export type Segment = MarkdownSegment | ChartSegment | ConfirmSegment | DataTableSegment | LocalFilesSegment;

// ─── Block Data Types ────────────────────────────────────

export interface ChartDataset {
  label: string;
  data: number[];
  backgroundColor?: string | string[];
  borderColor?: string | string[];
}

export interface ChartData {
  type: 'bar' | 'line' | 'pie' | 'doughnut' | 'radar';
  title?: string;
  labels: string[];
  datasets: ChartDataset[];
}

export interface ConfirmAction {
  label: string;
  value: string;
  variant?: 'primary' | 'secondary' | 'destructive';
}

export interface ConfirmData {
  text: string;
  actions: ConfirmAction[];
}

export interface DataTableColumn {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'currency' | 'percent' | 'boolean' | 'badge';
}

export interface DataTableData {
  title?: string;
  columns: DataTableColumn[];
  rows: Record<string, unknown>[];
}

export type LocalFileKind = 'file' | 'directory' | 'html' | 'pdf' | 'image' | 'markdown';

export interface LocalFileItem {
  path: string;
  label?: string;
  kind?: LocalFileKind;
  sourceBlock?: string;
}

export interface LocalFilesData {
  title?: string;
  files: LocalFileItem[];
}

// ─── Parser ──────────────────────────────────────────────

/**
 * Parse markdown string into segments of plain markdown and custom blocks.
 *
 * Custom blocks are detected by fenced code blocks with a known block type:
 *   ```chart
 *   { ... json ... }
 *   ```
 *
 * Preview blocks emitted by agents (html-preview/pdf-preview/image-preview/markdown-preview)
 * are rendered as local file cards when their `src` or `items[].src` points to a local path.
 *
 * Unknown code fence languages (javascript, python, etc.) are left as-is
 * inside markdown segments.
 */
export function parseSegments(markdown: string): Segment[] {
  if (!markdown) return [{ type: 'markdown', content: '' }];

  const segments: Segment[] = [];
  // Match ```blockType\n...content...\n```
  // Use a regex that captures the block type and content.
  const regex =
    /```(chart|confirm|datatable|html-preview|pdf-preview|image-preview|markdown-preview|local-file)\s*\n([\s\S]*?)```/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(markdown)) !== null) {
    // Add preceding markdown
    if (match.index > lastIndex) {
      appendMarkdownSegment(segments, markdown.slice(lastIndex, match.index));
    }

    const blockType = match[1] as KnownFenceBlock;
    const rawJson = match[2].trim();

    try {
      const data = parseBlockJson(blockType, rawJson);
      const localFiles = previewBlockToLocalFiles(blockType, data);
      if (localFiles) {
        segments.push({ type: 'local-files', data: localFiles });
      } else if (PREVIEW_BLOCKS.has(blockType)) {
        segments.push({
          type: 'markdown',
          content: '```' + blockType + '\n' + match[2] + '```',
        });
      } else {
        segments.push({ type: blockType, data } as Segment);
      }
    } catch (_err) {
      // Invalid JSON — fall back to rendering as a normal code block
      segments.push({
        type: 'markdown',
        content: '```' + blockType + '\n' + match[2] + '```',
      });
    }

    lastIndex = match.index + match[0].length;
  }

  // Add trailing markdown
  if (lastIndex < markdown.length) {
    appendMarkdownSegment(segments, markdown.slice(lastIndex));
  }

  // If nothing was parsed, return the whole thing as markdown
  if (segments.length === 0) {
    return [{ type: 'markdown', content: markdown }];
  }

  return segments;
}

// ─── Preview Block Helpers ───────────────────────────────

type KnownFenceBlock =
  | 'chart'
  | 'confirm'
  | 'datatable'
  | 'html-preview'
  | 'pdf-preview'
  | 'image-preview'
  | 'markdown-preview'
  | 'local-file';

const PREVIEW_BLOCKS = new Set<KnownFenceBlock>([
  'html-preview',
  'pdf-preview',
  'image-preview',
  'markdown-preview',
  'local-file',
]);

function appendMarkdownSegment(segments: Segment[], content: string): void {
  if (!content.trim()) return;
  segments.push({ type: 'markdown', content });
}

function parseBlockJson(blockType: KnownFenceBlock, rawJson: string): unknown {
  // LLM sometimes emits duplicate JSON keys (e.g. "rows":[...],"rows":[]).
  // JSON.parse keeps the last occurrence, which may be empty.
  // Fix: remove trailing duplicate empty-array "rows" before parsing.
  const sanitized = blockType === 'datatable' ? rawJson.replace(/,\s*"rows"\s*:\s*\[\s*\]\s*(?=\}\s*$)/, '') : rawJson;
  return JSON.parse(sanitized);
}

function previewBlockToLocalFiles(blockType: KnownFenceBlock, data: unknown): LocalFilesData | null {
  if (!PREVIEW_BLOCKS.has(blockType)) return null;
  if (!data || typeof data !== 'object') return null;

  const record = data as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title : undefined;
  const files: LocalFileItem[] = [];

  if (typeof record.src === 'string' && isLocalPath(record.src)) {
    files.push({
      path: record.src,
      label: title,
      kind: kindFromBlock(blockType, record.src),
      sourceBlock: blockType,
    });
  }

  if (Array.isArray(record.items)) {
    for (const item of record.items) {
      if (!item || typeof item !== 'object') continue;
      const itemRecord = item as Record<string, unknown>;
      const src = itemRecord.src;
      if (typeof src !== 'string' || !isLocalPath(src)) continue;
      files.push({
        path: src,
        label: typeof itemRecord.label === 'string' ? itemRecord.label : undefined,
        kind: kindFromBlock(blockType, src),
        sourceBlock: blockType,
      });
    }
  }

  if (typeof record.path === 'string' && isLocalPath(record.path)) {
    files.push({
      path: record.path,
      label: typeof record.label === 'string' ? record.label : title,
      kind: kindFromBlock(blockType, record.path),
      sourceBlock: blockType,
    });
  }

  return files.length > 0 ? { title, files } : null;
}

function kindFromBlock(blockType: KnownFenceBlock, path: string): LocalFileKind {
  if (blockType === 'html-preview') return 'html';
  if (blockType === 'pdf-preview') return 'pdf';
  if (blockType === 'image-preview') return 'image';
  if (blockType === 'markdown-preview') return 'markdown';

  const lower = path.toLowerCase();
  if (/\.(html?|xhtml)$/.test(lower)) return 'html';
  if (/\.pdf$/.test(lower)) return 'pdf';
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/.test(lower)) return 'image';
  if (/\.(md|mdx|markdown)$/.test(lower)) return 'markdown';
  return 'file';
}

function isLocalPath(path: string): boolean {
  return /^(~\/|\/|[A-Za-z]:[\\/])/.test(path.trim());
}
