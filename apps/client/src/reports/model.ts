/**
 * Client error reports on the device (React-free, ./model.test.ts): turning a caught error into a
 * redacted report, the queue that keeps the latest ones until the station takes them, and the
 * session mark that tells a crash the JS side never saw (a native abort, a worklet error on the
 * UI thread) from a normal end. The wire shape and the redaction rules are the station's
 * (../shared/client-reports.ts, vendored).
 */

import {
  CLIENT_REPORT_LIMITS,
  redactReportStack,
  redactReportText,
  reportRoute,
  type ClientReport,
  type ClientReportPlatform,
  type ClientReportSource,
} from '../shared/client-reports';

/** Reports kept on the device; the newest win. */
export const QUEUE_MAX = 30;
/** A report older than this is no longer worth sending. */
export const QUEUE_MAX_AGE_MS = 14 * 86_400_000;
/** The same error at the same place again within this window is the one report already queued. */
export const REPEAT_WINDOW_MS = 60_000;

/** A queued report and the station it happened on (sent only there; null = whichever is active). */
export interface QueuedReport extends ClientReport {
  station: string | null;
}

/** What a report says about the app around the error. */
export interface ReportContext {
  route: string | null;
  station: string | null;
  platform: ClientReportPlatform;
  os_version: string | null;
  app_version: string | null;
  app_build: string | null;
  api_level: number | null;
}

/** A report id: time first so a device's ids sort, then randomness. */
export function reportId(now: number, random: () => number = Math.random): string {
  const tail = Array.from({ length: 10 }, () => Math.floor(random() * 36).toString(36)).join('');
  return `cr_${now.toString(36)}${tail}`;
}

/** Name, message and stack of anything thrown (an Error, a string, an object, nothing). */
export function errorParts(error: unknown): { name: string; message: string; stack: string | null } {
  if (error instanceof Error || (error && typeof error === 'object' && 'message' in error)) {
    const value = error as { name?: unknown; message?: unknown; stack?: unknown };
    const name = typeof value.name === 'string' && value.name ? value.name : 'Error';
    const message = typeof value.message === 'string' ? value.message : String(value.message);
    const stack = typeof value.stack === 'string' && value.stack ? value.stack : null;
    return { name, message, stack };
  }
  if (typeof error === 'string') return { name: 'Error', message: error, stack: null };
  if (error === undefined || error === null) return { name: 'Error', message: String(error), stack: null };
  let message: string;
  try {
    message = JSON.stringify(error) ?? String(error);
  } catch {
    message = Object.prototype.toString.call(error);
  }
  return { name: 'NonError', message, stack: null };
}

/** A redacted report of `error` caught by `source`. */
export function buildReport(
  error: unknown,
  how: { fatal: boolean; source: ClientReportSource },
  context: ReportContext,
  now: number,
  id: string = reportId(now),
): QueuedReport {
  const parts = errorParts(error);
  const version = (value: string | null) => (value ? redactReportText(value, CLIENT_REPORT_LIMITS.version) : null);
  return {
    id,
    occurred_at: new Date(now).toISOString(),
    fatal: how.fatal,
    source: how.source,
    name: redactReportText(parts.name, CLIENT_REPORT_LIMITS.name),
    message: redactReportText(parts.message, CLIENT_REPORT_LIMITS.message),
    stack: parts.stack ? redactReportStack(parts.stack) : null,
    route: context.route ? reportRoute(context.route) : null,
    platform: context.platform,
    os_version: version(context.os_version),
    app_version: version(context.app_version),
    app_build: version(context.app_build),
    api_level: context.api_level,
    station: context.station,
  };
}

const sameError = (a: QueuedReport, b: QueuedReport) =>
  a.name === b.name && a.message === b.message && a.route === b.route && a.station === b.station;

/** Drop reports past their age. */
export function freshReports(queue: readonly QueuedReport[], now: number): QueuedReport[] {
  return queue.filter((report) => now - Date.parse(report.occurred_at) < QUEUE_MAX_AGE_MS);
}

/**
 * The queue with `report` added: a repeat of the same error at the same place within a minute is
 * not added again (a render loop throws every frame), a fatal one always is; the newest
 * QUEUE_MAX stay.
 */
export function enqueueReport(queue: readonly QueuedReport[], report: QueuedReport, now: number): QueuedReport[] {
  const kept = freshReports(queue, now);
  const repeat = kept.some(
    (queued) => sameError(queued, report) && now - Date.parse(queued.occurred_at) < REPEAT_WINDOW_MS,
  );
  if (repeat && !report.fatal) return kept;
  return [...kept, report].slice(-QUEUE_MAX);
}

/** The next batch for `station`: its own reports and those that belong to no station, oldest first. */
export function nextBatch(queue: readonly QueuedReport[], station: string | null, now: number): QueuedReport[] {
  return freshReports(queue, now)
    .filter((report) => report.station === null || report.station === station)
    .slice(0, CLIENT_REPORT_LIMITS.batch);
}

/** The report as the station takes it (without the device-only station). */
export function wireReport(report: QueuedReport): ClientReport {
  const { station: _station, ...wire } = report;
  return wire;
}

/** The queue without the reports the station took. */
export function settleReports(queue: readonly QueuedReport[], sent: readonly string[]): QueuedReport[] {
  const gone = new Set(sent);
  return queue.filter((report) => !gone.has(report.id));
}

/** What a send's answer means for the batch: gone (taken, or never takeable) or kept for later. */
export function sendOutcome(status: number): 'settle' | 'keep' {
  if (status >= 200 && status < 300) return 'settle';
  // refused as malformed, or from a member the station takes no reports from: refused forever
  if (status === 400 || status === 403 || status === 413) return 'settle';
  return 'keep';
}

/** A saved queue, keeping only entries that are still reports. */
export function parseQueue(raw: string | null): QueuedReport[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is QueuedReport =>
      !!item &&
      typeof item === 'object' &&
      typeof item.id === 'string' &&
      typeof item.occurred_at === 'string' &&
      typeof item.name === 'string' &&
      typeof item.message === 'string' &&
      typeof item.platform === 'string' &&
      typeof item.source === 'string',
  );
}

/**
 * The running session as last written: where it was and whether it was in the foreground. A
 * launch that finds the previous mark still `active` (and no fatal report written for it) knows
 * that session ended without the app going to the background first.
 */
export interface SessionMark {
  started_at: number;
  /** When the mark was last written (a route change, the app coming or going). */
  seen_at: number;
  route: string | null;
  station: string | null;
  active: boolean;
  /** A fatal JS error was already reported for this session. */
  reported: boolean;
}

export function parseMark(raw: string | null): SessionMark | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SessionMark>;
    if (typeof value.started_at !== 'number' || typeof value.active !== 'boolean') return null;
    return {
      started_at: value.started_at,
      seen_at: typeof value.seen_at === 'number' ? value.seen_at : value.started_at,
      route: typeof value.route === 'string' ? value.route : null,
      station: typeof value.station === 'string' ? value.station : null,
      active: value.active,
      reported: value.reported === true,
    };
  } catch {
    return null;
  }
}

/** The report for a previous session that ended in the foreground unseen (dated its last sign of life), or null. */
export function uncleanExitReport(
  previous: SessionMark | null,
  context: ReportContext,
  id?: string,
): QueuedReport | null {
  if (!previous || !previous.active || previous.reported) return null;
  return buildReport(
    {
      name: 'UncleanExit',
      message: 'The previous launch ended in the foreground without a JS error (native crash or system kill)',
    },
    { fatal: true, source: 'unclean_exit' },
    { ...context, route: previous.route, station: previous.station },
    previous.seen_at,
    id,
  );
}
