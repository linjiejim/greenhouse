import { z } from 'zod';
import { isoTime } from './common.js';

export const FILE_PURPOSES = [
  'attachment',
  'knowledge',
  'record',
  'artifact',
  'export',
  'import',
  'skill',
  'avatar',
  'branding',
] as const;
/** Purposes a member may upload directly; the rest are written by the server. */
export const UPLOAD_PURPOSES = ['attachment', 'avatar', 'branding'] as const;

export const fileSchema = z.object({
  id: z.string(),
  name: z.string(),
  content_type: z.string(),
  size_bytes: z.number().int(),
  purpose: z.enum(FILE_PURPOSES),
  owner_id: z.string().nullable(),
  conversation_id: z.string().nullable(),
  run_id: z.string().nullable(),
  /** Read the bytes here with the same credentials. */
  url: z.string(),
  created_at: isoTime,
});
export type FileView = z.infer<typeof fileSchema>;

/** Sent as multipart/form-data next to the `file` field. */
export const uploadFieldsSchema = z.object({
  purpose: z.enum(UPLOAD_PURPOSES).default('attachment'),
  conversation_id: z.string().optional(),
});
