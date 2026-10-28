/**
 * The report queue with its storage and transport passed in (React-free, ./reporter.test.ts).
 *
 * `record` writes the queue synchronously: a fatal error's handler returns into a runtime that is
 * about to abort, so the report must be on the device before it does. `flush` sends batches for
 * the active station oldest first and removes a batch only when the station took it (or refused
 * it as malformed, which it would forever); anything else keeps it for the next launch or
 * foreground. `beginSession` / `markSession` keep the session mark that reveals crashes the JS
 * side never saw (./model.ts `uncleanExitReport`).
 */

import type { ClientReport, ClientReportSource } from '../shared/client-reports';
import {
  buildReport,
  enqueueReport,
  freshReports,
  nextBatch,
  parseMark,
  parseQueue,
  sendOutcome,
  settleReports,
  uncleanExitReport,
  wireReport,
  type QueuedReport,
  type ReportContext,
  type SessionMark,
} from './model';

/** Synchronous storage (a file on the phone, localStorage in a browser); failures are swallowed by the caller. */
export interface ReportStorage {
  readQueue(): string | null;
  writeQueue(text: string): void;
  readMark(): string | null;
  writeMark(text: string): void;
}

export interface ReporterDeps {
  storage: ReportStorage;
  context: () => ReportContext;
  /** POST one batch to `station` (0 without sending when it is no longer the active one); the HTTP status, 0 when nothing came back. */
  send: (reports: ClientReport[], station: string | null) => Promise<number>;
  now?: () => number;
}

export function createReporter(deps: ReporterDeps) {
  const now = deps.now ?? Date.now;
  let queue: QueuedReport[] | null = null;
  let mark: SessionMark | null = null;
  let sending = false;

  const load = (): QueuedReport[] => {
    if (queue === null) {
      try {
        queue = parseQueue(deps.storage.readQueue());
      } catch {
        queue = [];
      }
    }
    return queue;
  };
  const save = (next: QueuedReport[]) => {
    queue = next;
    try {
      deps.storage.writeQueue(JSON.stringify(next));
    } catch {
      // a report that cannot be kept is lost, never a second error
    }
  };
  const writeMark = () => {
    if (!mark) return;
    try {
      deps.storage.writeMark(JSON.stringify(mark));
    } catch {
      // the mark is a hint
    }
  };

  const reporter = {
    /** Queue a report of `error`; never throws. */
    record(error: unknown, how: { fatal: boolean; source: ClientReportSource }): QueuedReport | null {
      try {
        const at = now();
        const report = buildReport(error, how, deps.context(), at);
        save(enqueueReport(load(), report, at));
        if (how.fatal && mark) {
          mark = { ...mark, reported: true, seen_at: at };
          writeMark();
        }
        return report;
      } catch {
        return null;
      }
    },

    /** What waits to be sent. */
    pending(): readonly QueuedReport[] {
      return load();
    },

    /** Send what belongs to `station`, batch by batch; the number of reports the station took. */
    async flush(station: string | null): Promise<number> {
      if (sending) return 0;
      sending = true;
      let taken = 0;
      try {
        const fresh = freshReports(load(), now());
        if (fresh.length !== load().length) save(fresh);
        for (;;) {
          const batch = nextBatch(load(), station, now());
          if (batch.length === 0) break;
          let status = 0;
          try {
            status = await deps.send(batch.map(wireReport), station);
          } catch {
            status = 0;
          }
          if (sendOutcome(status) === 'keep') break;
          save(
            settleReports(
              load(),
              batch.map((report) => report.id),
            ),
          );
          if (status >= 200 && status < 300) taken += batch.length;
        }
      } finally {
        sending = false;
      }
      return taken;
    },

    /**
     * Start this launch's session mark; a previous one that was still in the foreground becomes an
     * `unclean_exit` report. Call once, as early as possible.
     */
    beginSession(active: boolean): QueuedReport | null {
      let previous: SessionMark | null;
      try {
        previous = parseMark(deps.storage.readMark());
      } catch {
        previous = null;
      }
      const context = deps.context();
      const at = now();
      const unclean = uncleanExitReport(previous, context);
      if (unclean) save(enqueueReport(load(), unclean, at));
      mark = { started_at: at, seen_at: at, route: context.route, station: context.station, active, reported: false };
      writeMark();
      return unclean;
    },

    /** Keep the mark current: the route on screen, the station, whether the app is in the foreground. */
    markSession(patch: Partial<Pick<SessionMark, 'route' | 'station' | 'active'>>): void {
      if (!mark) return;
      const next = { ...mark, ...patch };
      if (next.route === mark.route && next.station === mark.station && next.active === mark.active) return;
      mark = { ...next, seen_at: now() };
      writeMark();
    },
  };
  return reporter;
}

export type Reporter = ReturnType<typeof createReporter>;
