/** Core schema building blocks used by plugin-owned tables and their foreign keys. */
export { at, createdAt, id, json, oneOf, updatedAt } from './schema/_columns.js';
export { users } from './schema/identity.js';

export { conversations } from './schema/conversations.js';
export { auditEvents } from './schema/audit.js';

export { day } from './schema/_columns.js';

export { fileLinks, files, shares, type FileLinkRow, type ShareRow } from './schema/files.js';

export { folders } from './schema/files.js';
export { searchColumns } from './schema/_columns.js';
