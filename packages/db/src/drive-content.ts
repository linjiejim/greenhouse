import type { Db } from './client.js';
const checks = new Map<string, (db: Db, folderId: string) => Promise<boolean>>();
export function registerDriveFolderContents(scope: string, check: (db: Db, folderId: string) => Promise<boolean>) {
  checks.set(scope, check);
}
export async function driveFolderHasContents(db: Db, scope: string, folderId: string) {
  return (await checks.get(scope)?.(db, folderId)) ?? false;
}
