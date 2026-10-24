/**
 * Files mutation — write side of the team's file cabinet (Files / 云盘):
 * folders, small uploads, rename / move, delete.
 *
 * Same rule as the browser: drive/kb-cabinet.ts authorizes every node with
 * resolveDriveAccess and keeps moves inside one shelf. Over MCP each call is a
 * recorded write in the member's name, and the delete actions take the
 * preview → confirm:true round trip (agent-access/risk.ts). Lazy: needs the
 * calling user (buildLazyServerTools).
 */

import { tool } from 'ai';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { DatabaseProvider } from '@greenhouse/db';
import { defineTool, type ToolMeta } from './define.js';
import { CITE_URL_INSTRUCTION } from './cite-url.js';
import { MAX_AGENT_UPLOAD_BYTES } from '../drive/cabinet-limits.js';
import {
  createCabinetFolder,
  deleteCabinetFile,
  deleteCabinetFolder,
  updateCabinetFile,
  updateCabinetFolder,
  uploadCabinetFile,
} from '../drive/kb-cabinet.js';
import { delegatedAgentActor } from '../platform/actor.js';
import type { FilesToolContext } from './files-query.js';

const MAX_MB = MAX_AGENT_UPLOAD_BYTES / 1024 / 1024;

const filesMutationSchema = z.object({
  action: z
    .enum(['folders.create', 'folders.update', 'folders.delete', 'files.upload', 'files.update', 'files.delete'])
    .describe(
      'folders.update / files.update rename and/or move. folders.delete only removes an empty folder. files.delete removes a file.',
    ),
  shelf: z
    .enum(['team', 'personal'])
    .optional()
    .describe('folders.create / files.upload: the team shelf or your personal shelf. Default team.'),
  folder_id: z.coerce
    .string()
    .nullable()
    .optional()
    .describe(
      'folders.update / folders.delete: the folder. files.upload: the folder to put the file in (omit for the shelf root). files.update: the folder to move into, null for the shelf root.',
    ),
  parent_id: z.coerce
    .string()
    .nullable()
    .optional()
    .describe(
      'folders.create: the parent folder (omit for the shelf root). folders.update: the new parent, null for the shelf root.',
    ),
  file_id: z.coerce.string().optional().describe('files.update / files.delete: the file.'),
  name: z.string().optional().describe('The new folder or file name, including the extension for files.'),
  text: z.string().optional().describe('files.upload: the file content as text (UTF-8).'),
  content_base64: z.string().optional().describe('files.upload: the file content as base64, for binary files.'),
});

type FilesMutationInput = z.infer<typeof filesMutationSchema>;

const meta: ToolMeta = {
  id: 'files_mutation',
  name: 'Files Mutation',
  brief: "Create folders, upload, rename, move and delete in the team's files",
  description: `Change the team's file cabinet (Files): create folders, upload a file (pass text or content_base64, up to ${MAX_MB} MB), rename or move within its shelf, delete. Moves never cross between the team and personal shelves. ${CITE_URL_INSTRUCTION}`,
  category: 'team',
  is_global: true,
  icon: 'FolderOpen',
  surface: { proxy: 'write', mcp: 'files' },
  sort_order: 19,
};

function need<T>(value: T | null | undefined, name: string): T {
  if (value === undefined || value === null) throw new Error(`${name} is required for this action`);
  return value;
}

function uploadBytes(input: FilesMutationInput): Buffer {
  if (input.text !== undefined && input.content_base64 !== undefined) {
    throw new Error('Pass either text or content_base64, not both');
  }
  if (input.text !== undefined) return Buffer.from(input.text, 'utf8');
  if (input.content_base64 !== undefined) {
    const cleaned = input.content_base64.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) throw new Error('content_base64 is not valid base64');
    return Buffer.from(cleaned, 'base64');
  }
  throw new Error('files.upload needs text or content_base64');
}

export function createFilesMutationTool(db: DatabaseProvider, ctx: FilesToolContext) {
  const caller = { db, userId: ctx.userId, actor: delegatedAgentActor({ userId: ctx.userId }) };
  return tool({
    description: meta.description,
    inputSchema: filesMutationSchema,
    execute: async (input: FilesMutationInput) => {
      try {
        switch (input.action) {
          case 'folders.create':
            return await createCabinetFolder(caller, {
              shelf: input.shelf ?? 'team',
              parentId: input.parent_id,
              name: need(input.name, 'name'),
            });
          case 'folders.update':
            return await updateCabinetFolder(caller, {
              folderId: need(input.folder_id, 'folder_id'),
              name: input.name,
              parentId: input.parent_id,
            });
          case 'folders.delete':
            return await deleteCabinetFolder(caller, need(input.folder_id, 'folder_id'));
          case 'files.upload':
            return await uploadCabinetFile(caller, {
              shelf: input.shelf ?? 'team',
              folderId: input.folder_id,
              name: need(input.name, 'name'),
              bytes: uploadBytes(input),
            });
          case 'files.update':
            return await updateCabinetFile(caller, {
              fileId: need(input.file_id, 'file_id'),
              name: input.name,
              folderId: input.folder_id,
            });
          case 'files.delete':
            return await deleteCabinetFile(caller, need(input.file_id, 'file_id'));
        }
      } catch (error) {
        return { error: toErrorMessage(error) };
      }
    },
  });
}

export const filesMutationTool = defineTool({ meta, kind: 'lazy' });
