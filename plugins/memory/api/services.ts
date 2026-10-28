import { getExtensionServices, type DatabaseProvider, type Db } from '@greenhouse/api/extension-kit';
import { createUserMemoryService } from './db/user-memories.js';
export function createServices(db: Db) {
  return { userMemories: createUserMemoryService(db) };
}
export type MemoryServices = ReturnType<typeof createServices>;
export function memoryServices(db: DatabaseProvider): MemoryServices {
  return getExtensionServices<MemoryServices>(db, 'memory');
}
