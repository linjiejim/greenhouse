/**
 * Record activity (history events + comments) and @mentions — slice C. The
 * history itself is already written by every record write (`onRecordWritten`);
 * `db.tables.listRecordEvents` is the read C builds the merged feed on.
 */

import { notImplemented, type TablesHandlers } from './shared.js';

export const activityHandlers = {
  listRecordActivity: notImplemented,
  createComment: notImplemented,
  updateComment: notImplemented,
  deleteComment: notImplemented,
} satisfies TablesHandlers;
