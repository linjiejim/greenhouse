/**
 * Report storage on the phone: two small JSON files in the documents directory, written
 * synchronously (a fatal error's handler runs just before the runtime aborts). They hold redacted
 * error text only, never tokens; they are not per member, because a crash can come before sign-in.
 * Browser: ./storage.web.ts.
 */

import { Directory, File, Paths } from 'expo-file-system';
import type { ReportStorage } from './reporter';

function file(name: string): File {
  const folder = new Directory(Paths.document, 'reports');
  if (!folder.exists) folder.create({ intermediates: true, idempotent: true });
  return new File(folder, name);
}

function read(name: string): string | null {
  const target = file(name);
  return target.exists ? target.textSync() : null;
}

export const reportStorage: ReportStorage = {
  readQueue: () => read('queue.json'),
  writeQueue: (text) => file('queue.json').write(text),
  readMark: () => read('session.json'),
  writeMark: (text) => file('session.json').write(text),
};
