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
  /**
   * The bytes, for this member only and for a short time: `<img src>`, `<a href download>` and
   * fetch all work without a bearer header. Web pages and SVG always download.
   */
  url: z.string(),
  /** When `url` stops working; get the file again for a fresh one. */
  expires_at: isoTime,
  created_at: isoTime,
});
export type FileView = z.infer<typeof fileSchema>;

/** The signature of a file URL: when it ends, who it was made for (none for the public logo), the MAC. */
export const fileContentQuerySchema = z.object({
  exp: z.coerce.number().int().positive(),
  m: z.string().min(1).max(64).optional(),
  sig: z.string().min(1).max(128),
});

/** Sent as multipart/form-data next to the `file` field. */
export const uploadFieldsSchema = z.object({
  purpose: z.enum(UPLOAD_PURPOSES).default('attachment'),
  conversation_id: z.string().optional(),
});
