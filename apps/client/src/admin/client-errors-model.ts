/**
 * Admin › Client errors, React-free (tested in ./models.test.ts): the words a group of reports
 * reads as. The station groups and redacts (apps/api/src/routes/client-reports.ts); this only lays
 * the answer out.
 */
import {
  CLIENT_REPORT_DAYS,
  type ClientErrorGroup,
  type ClientErrorReport,
  type ClientReportDays,
} from '../shared/client-reports';

export const CLIENT_ERROR_DAYS = CLIENT_REPORT_DAYS;
export type ClientErrorDays = ClientReportDays;

/** `TypeError: x is undefined`; a bare `Error` or a message that already names it reads as the message. */
export function errorHeadline(group: Pick<ClientErrorGroup, 'name' | 'message'>): string {
  const message = group.message.trim();
  if (!message) return group.name;
  if (group.name === 'Error' || message.startsWith(group.name)) return message;
  return `${group.name}: ${message}`;
}

/** The latest report's app: `4.0.0 (41 ota 1a2b3c4d)`, or null when the app did not say. */
export function appLine(latest: Pick<ClientErrorGroup['latest'], 'app_version' | 'app_build'>): string | null {
  if (!latest.app_version) return latest.app_build;
  return latest.app_build ? `${latest.app_version} (${latest.app_build})` : latest.app_version;
}

/** The headline numbers: reports in the window, kinds of error, kinds that ended the app. */
export function clientErrorTotals(report: Pick<ClientErrorReport, 'total' | 'groups'>) {
  return {
    reports: report.total,
    kinds: report.groups.length,
    fatal: report.groups.filter((group) => group.fatal).length,
  };
}
