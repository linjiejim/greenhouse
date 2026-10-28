/**
 * Client error reports — the wire contract between the universal client (`apps/client/src/reports/`)
 * and the station (`POST /api/client-reports`, super-only `GET /api/admin/client-reports`). The
 * client vendors this file verbatim (`apps/client/src/shared/client-reports.ts`, guarded by a
 * parity test), so it stays dependency-free.
 *
 * A report says what failed and where in the app, never what the member was reading or writing:
 * the error's name, message and stack pass `redactReportText` on the device and again on the
 * station (credentials, emails, long numbers, long quoted text and URL queries go), and the route
 * is a path without its query or fragment.
 */

export const CLIENT_REPORT_PLATFORMS = ['ios', 'android', 'web', 'desktop'] as const;
export type ClientReportPlatform = (typeof CLIENT_REPORT_PLATFORMS)[number];

/**
 * Where the client caught it: `global` the JS runtime's last-chance handler (native ErrorUtils),
 * `promise` an unhandled rejection, `boundary` a React error boundary, `window` the browser's
 * error event, `unclean_exit` the previous launch ended in the foreground without the JS side
 * seeing an error (a native crash, a worklet error on the UI thread, the system killing the app).
 */
export const CLIENT_REPORT_SOURCES = ['global', 'promise', 'boundary', 'window', 'unclean_exit'] as const;
export type ClientReportSource = (typeof CLIENT_REPORT_SOURCES)[number];

/** Windows the Admin section reads. */
export const CLIENT_REPORT_DAYS = [7, 30, 90] as const;
export type ClientReportDays = (typeof CLIENT_REPORT_DAYS)[number];

export const CLIENT_REPORT_LIMITS = {
  /** Reports per request. */
  batch: 20,
  /** Request body bytes. */
  bodyBytes: 64 * 1024,
  name: 120,
  message: 600,
  stack: 4000,
  stackLines: 40,
  route: 200,
  version: 40,
} as const;

/** A client-made report id: a resend of the same id is stored once. */
export const CLIENT_REPORT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export interface ClientReport {
  id: string;
  /** ISO instant on the device's clock. */
  occurred_at: string;
  fatal: boolean;
  source: ClientReportSource;
  name: string;
  message: string;
  stack: string | null;
  /** The route's path (`/sheet/doc`), never its query. */
  route: string | null;
  platform: ClientReportPlatform;
  os_version: string | null;
  app_version: string | null;
  app_build: string | null;
  /** The station's `mobile_api` when the app last read it. */
  api_level: number | null;
}

export interface ClientReportBatch {
  reports: ClientReport[];
}

export interface ClientReportAccepted {
  stored: number;
  /** Reports the station already had (same id from the same member). */
  duplicates: number;
  /** Entries that are not reports (dropped; the rest of the batch is kept). */
  rejected: number;
}

/** One kind of error in the Admin section: reports grouped by name and normalized message. */
export interface ClientErrorGroup {
  fingerprint: string;
  name: string;
  /** The newest report's message. */
  message: string;
  /** Any report in the group was fatal. */
  fatal: boolean;
  count: number;
  /** Distinct members who hit it. */
  members: number;
  platforms: ClientReportPlatform[];
  /** App versions that reported it, newest report first (at most five). */
  versions: string[];
  first_at: string;
  last_at: string;
  latest: Pick<
    ClientReport,
    'source' | 'stack' | 'route' | 'platform' | 'os_version' | 'app_version' | 'app_build' | 'api_level'
  >;
}

export interface ClientErrorReport {
  days: ClientReportDays;
  /** Reports in the window. */
  total: number;
  /** The most recently seen groups first (at most 100). */
  groups: ClientErrorGroup[];
}

const REDACTIONS: [RegExp, string | ((...match: string[]) => string)][] = [
  // URLs keep scheme, host and path: user info, query and fragment carry credentials and ids.
  [
    /\b((?:https?|wss?|greenhouse):\/\/)([^\s'"<>()]+)/gi,
    (_all, scheme, rest) => scheme + rest.replace(/^[^/@]*@/, '').replace(/[?#].*$/, ''),
  ],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g, '[token]'],
  [
    /\b(access_token|refresh_token|token|password|secret|api_key|apikey|authorization)(["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi,
    '$1$2[redacted]',
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  // Opaque runs (keys, signatures, push tokens); bundle file hashes stay for source maps.
  [/\b[A-Za-z0-9_-]{32,}\b(?!\.(?:js|bundle|map|hbc)\b)/g, '[secret]'],
  [/\b\d{11,}\b/g, '[number]'],
  // Long double-quoted text is content (a parse error quoting its input); single quotes name code.
  [/(["`“])[^"`”\n]{24,}(["`”])/g, '$1[text]$2'],
];

/** `text` without credentials, emails, long numbers or quoted content, cut to `max` characters. */
export function redactReportText(text: string, max: number): string {
  // control characters other than tab and newline
  let out = Array.from(text)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code === 9 || code === 10 || (code >= 32 && code !== 127);
    })
    .join('');
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, replacement as string);
  }
  return out.length > max ? `${out.slice(0, Math.max(0, max - 1))}…` : out;
}

/** A stack's first frames, redacted. */
export function redactReportStack(stack: string): string {
  const lines = stack.split('\n').slice(0, CLIENT_REPORT_LIMITS.stackLines);
  return redactReportText(lines.join('\n'), CLIENT_REPORT_LIMITS.stack);
}

/** A route path for a report: no query, no fragment, redacted. */
export function reportRoute(path: string): string | null {
  const bare = path.split(/[?#]/)[0]?.trim() ?? '';
  return bare ? redactReportText(bare, CLIENT_REPORT_LIMITS.route) : null;
}

/** What groups reports: the name and the message with numbers and ids folded. */
export function reportGroupingText(name: string, message: string): string {
  return `${name}: ${message}`
    .replace(/\b[a-z]{3}_[0-9A-HJKMNP-TV-Z]{26}\b/g, '<id>')
    .replace(/\d+/g, '#')
    .trim();
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? redactReportText(trimmed, max) : null;
}

/** A report as a client sent it, redacted again and cut to the limits; null when it is not one. */
export function parseClientReport(value: unknown): ClientReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.id !== 'string' || !CLIENT_REPORT_ID_PATTERN.test(input.id)) return null;
  if (typeof input.occurred_at !== 'string' || !Number.isFinite(Date.parse(input.occurred_at))) return null;
  if (!(CLIENT_REPORT_SOURCES as readonly unknown[]).includes(input.source)) return null;
  if (!(CLIENT_REPORT_PLATFORMS as readonly unknown[]).includes(input.platform)) return null;
  const name = text(input.name, CLIENT_REPORT_LIMITS.name) ?? 'Error';
  const message = text(input.message, CLIENT_REPORT_LIMITS.message) ?? '';
  const level = input.api_level;
  return {
    id: input.id,
    occurred_at: new Date(input.occurred_at).toISOString(),
    fatal: input.fatal === true,
    source: input.source as ClientReportSource,
    name,
    message,
    stack: typeof input.stack === 'string' && input.stack.trim() ? redactReportStack(input.stack) : null,
    route: typeof input.route === 'string' ? reportRoute(input.route) : null,
    platform: input.platform as ClientReportPlatform,
    os_version: text(input.os_version, CLIENT_REPORT_LIMITS.version),
    app_version: text(input.app_version, CLIENT_REPORT_LIMITS.version),
    app_build: text(input.app_build, CLIENT_REPORT_LIMITS.version),
    api_level: typeof level === 'number' && Number.isInteger(level) && level >= 0 && level < 1000 ? level : null,
  };
}
