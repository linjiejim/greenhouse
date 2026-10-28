/**
 * Files query — read side of the team's file cabinet (Files / 云盘): the
 * knowledge cabinet's team shelf plus the caller's personal shelf.
 *
 * Every node is authorized with resolveDriveAccess inside drive/kb-cabinet.ts,
 * the same rule /api/drive applies, so an agent sees exactly what its member
 * sees in the browser. Lazy: needs the calling user (buildLazyServerTools).
 */

import { tool } from 'ai';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { DatabaseProvider } from '@greenhouse/db';
import { defineTool, type ToolMeta } from './define.js';
import { CITE_URL_INSTRUCTION } from './cite-url.js';
import { DOWNLOAD_URL_TTL_SECONDS } from '../drive/cabinet-limits.js';
import {
  cabinetDownloadUrl,
  getCabinetFile,
  listCabinetFolder,
  readCabinetFile,
  searchCabinet,
} from '../drive/kb-cabinet.js';
import { delegatedAgentActor } from '../plugin-host/actor.js';

const filesQuerySchema = z.object({
  action: z
    .enum(['files.list', 'files.search', 'files.get', 'files.read', 'files.download_url'])
    .describe(
      'files.list: one folder level (folders + files). files.search: by name across both shelves. files.get: one file with its folder path. files.read: the text of a document. files.download_url: a short-lived link to the original bytes.',
    ),
  shelf: z
    .enum(['team', 'personal'])
    .optional()
    .describe('files.list: the team shelf (shared with everyone) or your personal shelf. Default team.'),
  folder_id: z.coerce.string().optional().describe('files.list: the folder to open; omit for the shelf root.'),
  query: z.string().optional().describe('files.search: part of a file or folder name.'),
  limit: z.number().int().min(1).max(50).optional().describe('files.search: max results per kind (default 20).'),
  file_id: z.coerce.string().optional().describe('files.get / files.read / files.download_url: the file.'),
  max_chars: z
    .number()
    .int()
    .min(1)
    .max(100_000)
    .optional()
    .describe('files.read: cut the text after this many characters (default 20000).'),
});

type FilesQueryInput = z.infer<typeof filesQuerySchema>;

const meta: ToolMeta = {
  id: 'files_query',
  name: 'Files',
  brief: "Browse, search and read the team's files and your own",
  description: `Read the team's file cabinet (Files): the team shelf everyone shares and your personal shelf. files.read returns text for text, CSV, JSON, Office (.docx/.xlsx) and PDFs with a text layer; scans and encrypted PDFs come back as an error, not as empty text. files.download_url links expire after ${DOWNLOAD_URL_TTL_SECONDS / 60} minutes. ${CITE_URL_INSTRUCTION}`,
  category: 'team',
  is_global: true,
  icon: 'FolderOpen',
  surface: { proxy: 'read', mcp: 'files' },
  sort_order: 18,
};

export interface FilesToolContext {
  userId: string;
}

function need<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is required for this action`);
  return value;
}

export function createFilesQueryTool(db: DatabaseProvider, ctx: FilesToolContext) {
  const caller = { db, userId: ctx.userId, actor: delegatedAgentActor({ userId: ctx.userId }) };
  return tool({
    description: meta.description,
    inputSchema: filesQuerySchema,
    execute: async (input: FilesQueryInput) => {
      try {
        switch (input.action) {
          case 'files.list':
            return await listCabinetFolder(caller, { shelf: input.shelf ?? 'team', folderId: input.folder_id });
          case 'files.search':
            return await searchCabinet(caller, { query: need(input.query, 'query'), limit: input.limit });
          case 'files.get':
            return await getCabinetFile(caller, need(input.file_id, 'file_id'));
          case 'files.read':
            return await readCabinetFile(caller, { fileId: need(input.file_id, 'file_id'), maxChars: input.max_chars });
          case 'files.download_url':
            return await cabinetDownloadUrl(caller, need(input.file_id, 'file_id'));
        }
      } catch (error) {
        return { error: toErrorMessage(error) };
      }
    },
  });
}

export const filesQueryTool = defineTool({ meta, kind: 'lazy' });
