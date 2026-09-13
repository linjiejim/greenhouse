/**
 * Shared utility functions for the web frontend.
 */

/** App version — injected at build time by esbuild, falls back to 0.0.0 */
declare const __APP_VERSION__: string;
export const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';

/** Safely parse JSON with a fallback value. */
export function safeParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json);
  } catch (_err) {
    return fallback;
  }
}

/** Relative time string (e.g. "3m", "2h", "5d"). */
export function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const zh = displayLocale().startsWith('zh');
  if (diffMs < 0) return zh ? '刚刚' : 'now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return zh ? '刚刚' : 'now';
  if (minutes < 60) return zh ? `${minutes}分` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return zh ? `${hours}小时` : `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return zh ? `${days}天` : `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return zh ? `${months}个月` : `${months}mo`;
  const years = Math.floor(months / 12);
  return zh ? `${years}年` : `${years}y`;
}

function displayLocale(): string {
  if (typeof document !== 'undefined' && document.documentElement.lang) return document.documentElement.lang;
  if (typeof navigator !== 'undefined' && navigator.language) return navigator.language;
  return 'en-US';
}

/** Format date for display (e.g. "May 14, 2026, 10:30 PM"). */
export function formatDate(dateStr?: string): string {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleString(displayLocale(), {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Format a date without the clock (e.g. "May 14, 2026").
 *
 * For calendar-grained fields — registration date, shipped-on, follow-up due —
 * where `formatDate`'s "12:00 AM" is noise that also eats table column width.
 */
export function formatDay(dateStr?: string): string {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleDateString(displayLocale(), { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Time ago string (e.g. "3m ago", "2h ago"). */
export function timeAgo(dateStr?: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const mins = Math.floor(diff / 60000);
  const zh = displayLocale().startsWith('zh');
  if (mins < 1) return zh ? '刚刚' : 'just now';
  if (mins < 60) return zh ? `${mins} 分钟前` : `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return zh ? `${hrs} 小时前` : `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return zh ? `${days} 天前` : `${days}d ago`;
  return d.toLocaleDateString(displayLocale(), { month: 'short', day: 'numeric' });
}

/** Format token count (e.g. "1.2M", "450k"). */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

// ─── Workspace Color ─────────────────────────────────────

export interface WorkspaceColorConfig {
  /** Dot background class */
  dot: string;
  /** Text color class */
  text: string;
  /** Badge background + text classes */
  badge: string;
  /** Short label */
  label: string;
}

const WORKSPACE_COLORS: Record<string, WorkspaceColorConfig> = {
  local: { dot: 'bg-fg-faint', text: 'text-fg-faint', badge: 'bg-surface-muted text-fg-muted', label: 'local' },
  dev: { dot: 'bg-warning', text: 'text-warning', badge: 'bg-warning-subtle text-warning', label: 'dev' },
  prod: {
    dot: 'bg-primary-500',
    text: 'text-primary-500',
    badge: 'bg-primary-subtle text-primary-fg-strong',
    label: 'prod',
  },
};

const DEFAULT_WS_COLOR: WorkspaceColorConfig = {
  dot: 'bg-fg-faint',
  text: 'text-fg-faint',
  badge: 'bg-surface-muted text-fg-muted',
  label: 'env',
};

/** Get color config for a workspace ID. */
export function getWorkspaceColor(wsId: string): WorkspaceColorConfig {
  return WORKSPACE_COLORS[wsId] ?? DEFAULT_WS_COLOR;
}

// ─── Role Badge Styles (shared across sidebar, user management, usage pages) ──

/** Semantic-token role badge styles for bordered variant (user lists, sidebar). */
export const roleBadgeStyles: Record<string, string> = {
  super: 'text-info border-info',
  team: 'text-fg-secondary border-edge',
};

// ─── HTML Sanitization ───────────────────────────────────

/**
 * Safe HTML tags — inline formatting only.
 * Anything not in this set will have its children preserved but the tag removed.
 */
const SAFE_TAGS = new Set([
  'b',
  'i',
  'u',
  'em',
  'strong',
  'a',
  'br',
  'span',
  'sub',
  'sup',
  'mark',
  'code',
  's',
  'del',
  'ins',
  'small',
  'abbr',
  'kbd',
]);
const SAFE_ATTRS = new Set(['href', 'target', 'rel', 'class', 'style', 'title']);

function sanitizeNode(node: Node): void {
  const children = Array.from(node.childNodes);
  for (const child of children) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      const tag = el.tagName.toLowerCase();

      if (!SAFE_TAGS.has(tag)) {
        while (el.firstChild) {
          node.insertBefore(el.firstChild, el);
        }
        node.removeChild(el);
        continue;
      }

      const attrs = Array.from(el.attributes);
      for (const attr of attrs) {
        if (!SAFE_ATTRS.has(attr.name)) {
          el.removeAttribute(attr.name);
        }
      }

      if (el.hasAttribute('href')) {
        const href = el.getAttribute('href') || '';
        if (href.trim().toLowerCase().startsWith('javascript:')) {
          el.setAttribute('href', '#');
        }
      }

      if (tag === 'a') {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }

      sanitizeNode(el);
    }
  }
}

/**
 * Sanitize HTML string using DOMParser + whitelist.
 * Strips dangerous tags (script, iframe, etc.) and attributes (onclick, onerror, etc.)
 * while keeping safe inline formatting (b, i, a, span, etc.).
 *
 * Use this for ALL dangerouslySetInnerHTML usage.
 */
export function sanitizeHtml(html: string): string {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const body = doc.body;
  sanitizeNode(body);
  return body.innerHTML;
}

/**
 * Strip all HTML tags and return plain text.
 * Useful for previews / truncated displays where no HTML is needed.
 */
export function stripHtmlToText(html: string): string {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return doc.body.textContent || '';
}

// ─── Chart / Data-Viz Color Palette (theme-adaptive) ─────

/** Restrained Greenhouse brand palette for charts and data-viz.
 *  `rgb` is kept in sync with the fixed primary anchors in theme.ts for canvas
 *  consumers such as Chart.js. */
export const CHART_PALETTE = [
  { bg: 'bg-primary-500', text: 'text-primary-fg-strong', light: 'bg-primary-subtle', rgb: '46, 139, 61' },
  { bg: 'bg-primary-400', text: 'text-primary-fg-strong', light: 'bg-primary-subtle', rgb: '140, 198, 63' },
  { bg: 'bg-primary-700', text: 'text-primary-fg-strong', light: 'bg-primary-subtle', rgb: '31, 107, 52' },
  { bg: 'bg-primary-300', text: 'text-primary-fg', light: 'bg-primary-subtle', rgb: '199, 217, 216' },
  { bg: 'bg-primary-600', text: 'text-primary-fg-strong', light: 'bg-primary-subtle', rgb: '39, 122, 53' },
] as const;

// ─── Domain → Tag tone maps ──────────────────────────────
// Single source of truth for status/result/stage colors, consumed by <Tag tone>.
// Replaces the per-file STATUS_BADGE_VARIANT / RESULT_BADGE_VARIANT / STAGE_VARIANTS
// dictionaries that were duplicated across inquiry and CRM pages.

/** Semantic tone for the shared <Tag> component (defined here so tone maps below
 *  carry no dependency on components/). */
export type TagTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

/** Semantic tone palette for deterministic datatable badge columns. */
export const BADGE_PALETTE: readonly TagTone[] = ['primary', 'info', 'warning', 'danger', 'success', 'neutral'];

/** Inquiry status (DB enum stays Chinese) → Tag tone. */
export const INQUIRY_STATUS_TONE: Record<string, TagTone> = {
  进行中: 'warning',
  已回复: 'neutral',
  已解决: 'success',
  已关闭: 'danger',
  未解决: 'warning',
  已拆分: 'neutral',
};

/** Inquiry resolution result (DB enum stays Chinese) → Tag tone. */
export const INQUIRY_RESULT_TONE: Record<string, TagTone> = {
  '已补发-整机': 'info',
  '已补发-配件': 'info',
  '已补发-回寄': 'info',
  已退货: 'warning',
  已换货: 'primary',
  换货: 'info',
  退款: 'warning',
  维修: 'primary',
  拒绝: 'danger',
  补发: 'success',
  待定: 'neutral',
};

/** User role → Tag tone (mirrors roleBadgeStyles; consumed by user/usage tables). */
export const ROLE_TONE: Record<string, TagTone> = {
  super: 'info',
  team: 'neutral',
};

/** CRM deal stage → Tag tone (and Badge variant fallback). */
export const DEAL_STAGE_TONE: Record<string, TagTone> = {
  draft: 'primary',
  sent: 'neutral',
  negotiating: 'warning',
  won: 'success',
  lost: 'danger',
  cancelled: 'neutral',
};
