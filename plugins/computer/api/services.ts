import { getExtensionServices, type DatabaseProvider, type Db } from '@greenhouse/api/extension-kit';
import { createMemberComputerService } from './db/member-computers.js';
export function createServices(db: Db) {
  return { memberComputers: createMemberComputerService(db) };
}
export type ComputerServices = ReturnType<typeof createServices>;
export function computerServices(db: DatabaseProvider): ComputerServices {
  return getExtensionServices<ComputerServices>(db, 'computer');
}
