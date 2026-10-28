/** Report storage in a browser (and the macOS shell): localStorage, written synchronously. */

import type { ReportStorage } from './reporter';

const QUEUE = 'greenhouse_client_reports';
const MARK = 'greenhouse_client_session';

export const reportStorage: ReportStorage = {
  readQueue: () => localStorage.getItem(QUEUE),
  writeQueue: (text) => localStorage.setItem(QUEUE, text),
  readMark: () => localStorage.getItem(MARK),
  writeMark: (text) => localStorage.setItem(MARK, text),
};
