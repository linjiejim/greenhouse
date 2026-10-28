/**
 * Client error report service (`client_reports`).
 *
 * `record` stores a member's already-validated, redacted reports (`parseClientReport` in
 * `@greenhouse/types/client-reports`); a report id the member sent before is skipped, so a client
 * that resends after a lost answer stores nothing twice. `summarize` is the Admin read: reports
 * received in a window, grouped by fingerprint (name + normalized message), most recently seen
 * first. Retention (90 days, 10,000 rows) lives in `retention.ts`.
 */

import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { safeJsonParse } from '@greenhouse/utils/json';
import {
  reportGroupingText,
  type ClientErrorGroup,
  type ClientReport,
  type ClientReportPlatform,
  type ClientReportSource,
} from '@greenhouse/types/client-reports';

import type { Db } from '../client.js';
import { newId } from '../ids.js';
import { clientReports } from '../schema/index.js';

/** Groups the Admin read returns at most. */
export const CLIENT_REPORT_GROUP_LIMIT = 100;

/** The grouping key of a report: a short hash of its name and normalized message. */
export function clientReportFingerprint(name: string, message: string): string {
  return createHash('sha256').update(reportGroupingText(name, message)).digest('hex').slice(0, 16);
}

const ISO = (column: SQL) => sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

interface GroupRow {
  fingerprint: string;
  count: number | string;
  members: number | string;
  fatal: boolean;
  first_at: string;
  last_at: string;
  platforms: unknown;
  versions: unknown;
  name: string;
  message: string;
  source: ClientReportSource;
  stack: string | null;
  route: string | null;
  platform: ClientReportPlatform;
  os_version: string | null;
  app_version: string | null;
  app_build: string | null;
  api_level: number | null;
}

export function createClientReportService(db: Db) {
  const service = {
    /** Store `reports` from one member; ids that member already sent are skipped. */
    async record(userId: string, reports: readonly ClientReport[]): Promise<{ stored: number; duplicates: number }> {
      if (reports.length === 0) return { stored: 0, duplicates: 0 };
      const rows = await db
        .insert(clientReports)
        .values(
          reports.map((report) => ({
            id: newId('clientReport'),
            user_id: userId,
            client_report_id: report.id,
            fingerprint: clientReportFingerprint(report.name, report.message),
            fatal: report.fatal,
            source: report.source,
            name: report.name,
            message: report.message,
            stack: report.stack,
            route: report.route,
            platform: report.platform,
            os_version: report.os_version,
            app_version: report.app_version,
            app_build: report.app_build,
            api_level: report.api_level,
            occurred_at: report.occurred_at,
          })),
        )
        .onConflictDoNothing({ target: [clientReports.user_id, clientReports.client_report_id] })
        .returning({ id: clientReports.id });
      return { stored: rows.length, duplicates: reports.length - rows.length };
    },

    /** Reports received since `since` (ISO): their count and their groups, most recently seen first. */
    async summarize(
      since: string,
      limit: number = CLIENT_REPORT_GROUP_LIMIT,
    ): Promise<{ total: number; groups: ClientErrorGroup[] }> {
      const [totals] = (await db.execute(sql`
        SELECT count(*)::int AS total FROM client_reports WHERE created_at >= ${since}::timestamptz`)) as unknown as {
        total: number | string;
      }[];
      const rows = (await db.execute(sql`
        WITH win AS (
          SELECT * FROM client_reports WHERE created_at >= ${since}::timestamptz
        ),
        grp AS (
          SELECT fingerprint,
                 count(*) AS count,
                 count(DISTINCT user_id) AS members,
                 bool_or(fatal) AS fatal,
                 min(occurred_at) AS first_at,
                 max(occurred_at) AS last_at,
                 jsonb_agg(DISTINCT platform) AS platforms
          FROM win GROUP BY fingerprint
        ),
        latest AS (
          SELECT DISTINCT ON (fingerprint) *
          FROM win ORDER BY fingerprint, occurred_at DESC, created_at DESC, id DESC
        )
        SELECT g.fingerprint, g.count, g.members, g.fatal, g.platforms,
               ${ISO(sql`g.first_at`)} AS first_at,
               ${ISO(sql`g.last_at`)} AS last_at,
               (SELECT coalesce(jsonb_agg(v.app_version ORDER BY v.seen DESC), '[]'::jsonb)
                FROM (SELECT app_version, max(occurred_at) AS seen FROM win
                      WHERE win.fingerprint = g.fingerprint AND app_version IS NOT NULL
                      GROUP BY app_version ORDER BY seen DESC LIMIT 5) v) AS versions,
               l.name, l.message, l.source, l.stack, l.route, l.platform,
               l.os_version, l.app_version, l.app_build, l.api_level
        FROM grp g JOIN latest l ON l.fingerprint = g.fingerprint
        ORDER BY g.last_at DESC, g.fingerprint
        LIMIT ${limit}`)) as unknown as GroupRow[];
      return {
        total: Number(totals?.total ?? 0),
        groups: rows.map((row) => ({
          fingerprint: row.fingerprint,
          name: row.name,
          message: row.message,
          fatal: row.fatal,
          count: Number(row.count),
          members: Number(row.members),
          platforms: (safeJsonParse(row.platforms, []) as ClientReportPlatform[]).sort(),
          versions: safeJsonParse(row.versions, []) as string[],
          first_at: row.first_at,
          last_at: row.last_at,
          latest: {
            source: row.source,
            stack: row.stack,
            route: row.route,
            platform: row.platform,
            os_version: row.os_version,
            app_version: row.app_version,
            app_build: row.app_build,
            api_level: row.api_level === null ? null : Number(row.api_level),
          },
        })),
      };
    },
  };
  return service;
}

export type ClientReportService = ReturnType<typeof createClientReportService>;
