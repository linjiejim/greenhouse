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
  if (diffMs < 0) return 'now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(months / 12);
  return `${years}y`;
}

/** Format date for display (e.g. "May 14, 2026, 10:30 PM"). */
export function formatDate(dateStr?: string): string {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Time ago string (e.g. "3m ago", "2h ago"). */
export function timeAgo(dateStr?: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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
  admin: 'text-info border-info', // legacy
  member: 'text-fg-secondary border-edge', // legacy
  external: 'text-warning border-warning',
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

/** Ordered palette for charts, badges, pipeline stages, and data-viz.
 *  `bg`/`text`/`light` are Tailwind classes for CSS-rendered consumers (uses
 *  semantic tokens where possible; some rely on dark-theme overrides in app.css
 *  for contrast). `rgb` is the raw `r, g, b` triplet for canvas consumers (e.g.
 *  Chart.js) that can't read Tailwind classes — kept in sync with the matching
 *  token's value. */
export const CHART_PALETTE = [
  { bg: 'bg-primary-500', text: 'text-primary-fg-strong', light: 'bg-primary-subtle', rgb: '20, 184, 166' },
  { bg: 'bg-info', text: 'text-info', light: 'bg-info-subtle', rgb: '59, 130, 246' },
  { bg: 'bg-warning', text: 'text-warning', light: 'bg-warning-subtle', rgb: '245, 158, 11' },
  { bg: 'bg-purple-500', text: 'text-purple-700', light: 'bg-purple-50', rgb: '168, 85, 247' },
  { bg: 'bg-danger', text: 'text-danger', light: 'bg-danger-subtle', rgb: '239, 68, 68' },
  { bg: 'bg-success', text: 'text-success', light: 'bg-success-subtle', rgb: '16, 185, 129' },
  { bg: 'bg-orange-500', text: 'text-orange-700', light: 'bg-orange-50', rgb: '249, 115, 22' },
  { bg: 'bg-cyan-500', text: 'text-cyan-700', light: 'bg-cyan-50', rgb: '6, 182, 212' },
] as const;

/** Badge color palette (border variant) for datatable badge columns. */
export const BADGE_PALETTE = [
  'bg-primary-subtle text-primary-fg-strong border-primary-edge',
  'bg-info-subtle text-info border-info',
  'bg-warning-subtle text-warning border-warning',
  'bg-purple-50 text-purple-700 border-purple-200',
  'bg-danger-subtle text-danger border-danger',
  'bg-success-subtle text-success border-success',
] as const;

// ─── Domain → Tag tone maps ──────────────────────────────
// Single source of truth for status/result/stage colors, consumed by <Tag tone>.

/** Semantic tone for the shared <Tag> component (defined here so tone maps below
 *  carry no dependency on components/). */
export type TagTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

/** User role → Tag tone (mirrors roleBadgeStyles; consumed by user/usage tables). */
export const ROLE_TONE: Record<string, TagTone> = {
  super: 'info',
  team: 'neutral',
  admin: 'info', // legacy
  member: 'neutral', // legacy
  external: 'warning',
};
