import { z } from 'zod';
import { AUDIENCE_TYPES } from './agents.js';
import { isoTime } from './common.js';

/**
 * The knowledge base (KNOW-01 to KNOW-16): one tree per space with folders, docs and files.
 * Docs are Markdown; a save names the version it is based on and a newer one refuses it.
 */

/** Where an item lives: the team's space (every member reads and writes) or a member's own. */
export const KNOWLEDGE_SPACES = ['team', 'personal'] as const;
export type KnowledgeSpace = (typeof KNOWLEDGE_SPACES)[number];
/** Where a list starts: the team space, my own, or what others shared with me. */
export const KNOWLEDGE_SCOPES = ['team', 'personal', 'shared'] as const;
export type KnowledgeScope = (typeof KNOWLEDGE_SCOPES)[number];
/** What the reader may do with an item: owner (their own space), editor or viewer. */
export const KNOWLEDGE_ACCESS = ['owner', 'editor', 'viewer'] as const;
export type KnowledgeAccess = (typeof KNOWLEDGE_ACCESS)[number];
export const KNOWLEDGE_SHARE_ROLES = ['viewer', 'editor'] as const;
export type KnowledgeShareRole = (typeof KNOWLEDGE_SHARE_ROLES)[number];
export const KNOWLEDGE_ITEM_TYPES = ['folder', 'doc', 'file'] as const;
export type KnowledgeItemType = (typeof KNOWLEDGE_ITEM_TYPES)[number];
export const COMMENT_TARGETS = ['doc', 'record'] as const;
export const PRESENCE_STATES = ['viewing', 'editing'] as const;
export type PresenceState = (typeof PRESENCE_STATES)[number];
export const DIFF_MODES = ['line', 'word'] as const;
/** How the web can show a file from its URL. */
export const KNOWLEDGE_PREVIEWS = ['image', 'pdf', 'text', 'audio', 'video', 'none'] as const;

export const FOLDER_NAME_MAX = 120;
export const DOC_TITLE_MAX = 200;
export const DOC_CONTENT_MAX = 500_000;
export const CHANGE_NOTE_MAX = 300;
export const COMMENT_BODY_MAX = 10_000;

/**
 * A doc's address in the app and inside Markdown: `[Title](#/knowledge/<doc id>)`. Saving a doc
 * records these links (backlinks); the editor's `[[` inserts one.
 */
export const docHref = (docId: string) => `#/knowledge/${docId}`;
/** A member mentioned in Markdown: `[@Name](member:<member id>)`; a new mention notifies them. */
export const mentionHref = (memberId: string) => `member:${memberId}`;

export const memberRefSchema = z.object({ id: z.string(), name: z.string() });
export type MemberRef = z.infer<typeof memberRefSchema>;
export const agentRefSchema = z.object({ id: z.string(), name: z.string() });
export type AgentRef = z.infer<typeof agentRefSchema>;

/** One folder above an item, from the root of its space down. */
export const pathEntrySchema = z.object({ id: z.string(), name: z.string() });
export type PathEntry = z.infer<typeof pathEntrySchema>;

/** A row of the tree: a folder, a doc or a file. */
export const knowledgeItemSchema = z.object({
  type: z.enum(KNOWLEDGE_ITEM_TYPES),
  id: z.string(),
  /** A folder's or a file's name, a doc's title. */
  name: z.string(),
  space: z.enum(KNOWLEDGE_SPACES),
  /** The folder it is in; null at the root of its space. */
  folder_id: z.string().nullable(),
  /** The member whose personal space holds it; null in the team space. */
  owner_id: z.string().nullable(),
  /** 0 until someone put it in order by hand. */
  sort_order: z.number().int(),
  access: z.enum(KNOWLEDGE_ACCESS),
  /** It has shares of its own (folders and docs). */
  shared: z.boolean(),
  /** A folder that is an Agent's private reference folder: that Agent. */
  agent_id: z.string().nullable(),
  /** A doc offered under "new from template". */
  is_template: z.boolean(),
  /** Files only. */
  content_type: z.string().nullable(),
  size_bytes: z.number().int().nullable(),
  archived_at: isoTime.nullable(),
  updated_at: isoTime,
});
export type KnowledgeItem = z.infer<typeof knowledgeItemSchema>;

export const knowledgeItemsSchema = z.object({ items: z.array(knowledgeItemSchema) });

export const knowledgeFolderSchema = knowledgeItemSchema.extend({
  path: z.array(pathEntrySchema),
  /**
   * What is in it, in tree order: hand-ordered items first, then folders, then docs and files by
   * name (at most 1000). An archived folder shows what was archived with it.
   */
  children: z.array(knowledgeItemSchema),
  created_by: memberRefSchema.nullable(),
  created_at: isoTime,
});
export type KnowledgeFolder = z.infer<typeof knowledgeFolderSchema>;

/** Search metadata only: never shown as part of the doc. */
export const docMetaSchema = z.object({
  summary: z.string().max(1000).optional(),
  questions: z.array(z.string().max(200)).max(20).optional(),
  topics: z.array(z.string().max(100)).max(20).optional(),
});
export type DocMeta = z.infer<typeof docMetaSchema>;

export const knowledgeDocSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Markdown, the source of truth. File links are signed for the reader; saves may send them back as they are. */
  content: z.string(),
  space: z.enum(KNOWLEDGE_SPACES),
  folder_id: z.string().nullable(),
  owner_id: z.string().nullable(),
  path: z.array(pathEntrySchema),
  is_template: z.boolean(),
  tags: z.array(z.string()),
  meta: docMetaSchema,
  /** Send it back with a change; a newer one answers 409 `stale_version`. */
  version: z.number().int(),
  sort_order: z.number().int(),
  access: z.enum(KNOWLEDGE_ACCESS),
  shared: z.boolean(),
  /** Set when the doc is in an Agent's private reference folder: that Agent. */
  agent_id: z.string().nullable(),
  created_by: memberRefSchema.nullable(),
  updated_by: memberRefSchema.nullable(),
  /** The Agent that wrote the current version for `updated_by`, when one did. */
  updated_by_agent: agentRefSchema.nullable(),
  archived_at: isoTime.nullable(),
  created_at: isoTime,
  updated_at: isoTime,
});
export type KnowledgeDoc = z.infer<typeof knowledgeDocSchema>;

const idField = z.string().min(1).max(64);
const tagsField = z.array(z.string().trim().min(1).max(40)).max(20);

export const rootQuerySchema = z.object({ space: z.enum(KNOWLEDGE_SCOPES) });
export const spaceQuerySchema = z.object({ space: z.enum(KNOWLEDGE_SPACES) });

export const createFolderInputSchema = z.object({
  name: z.string().trim().min(1).max(FOLDER_NAME_MAX),
  /** Inside this folder (and its space); else at the root of `space`, personal by default. */
  folder_id: idField.optional(),
  space: z.enum(KNOWLEDGE_SPACES).optional(),
});
export type CreateFolderInput = z.infer<typeof createFolderInputSchema>;

/**
 * Rename or move. A move goes into `folder_id`, or to the root of `space` with `folder_id: null`.
 * Never into itself or below; personal items move into the team space, never back.
 */
export const updateFolderInputSchema = z.object({
  name: z.string().trim().min(1).max(FOLDER_NAME_MAX).optional(),
  folder_id: idField.nullable().optional(),
  space: z.enum(KNOWLEDGE_SPACES).optional(),
});
export type UpdateFolderInput = z.infer<typeof updateFolderInputSchema>;

/** The order of some items of one folder (or the root of a space), as they should appear. */
export const reorderInputSchema = z.object({
  folder_id: idField.nullable(),
  /** Needed at the root (`folder_id: null`). */
  space: z.enum(KNOWLEDGE_SPACES).optional(),
  items: z
    .array(z.object({ type: z.enum(KNOWLEDGE_ITEM_TYPES), id: idField }))
    .min(1)
    .max(1000),
});
export type ReorderInput = z.infer<typeof reorderInputSchema>;

export const docListQuerySchema = z.object({
  space: z.enum(KNOWLEDGE_SCOPES).optional(),
  /** Only templates (true) or only other docs (false). */
  template: z.enum(['true', 'false']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const createDocInputSchema = z
  .object({
    title: z.string().trim().min(1).max(DOC_TITLE_MAX).optional(),
    content: z.string().max(DOC_CONTENT_MAX).optional(),
    folder_id: idField.optional(),
    space: z.enum(KNOWLEDGE_SPACES).optional(),
    /** Start from this template: its title (unless given), content and tags. */
    template_id: idField.optional(),
    is_template: z.boolean().optional(),
    tags: tagsField.optional(),
    meta: docMetaSchema.optional(),
    change_note: z.string().trim().max(CHANGE_NOTE_MAX).optional(),
  })
  .refine((input) => input.title !== undefined || input.template_id !== undefined, {
    message: 'Give the doc a title, or start from a template.',
    path: ['title'],
  });
export type CreateDocInput = z.infer<typeof createDocInputSchema>;

export const updateDocInputSchema = z
  .object({
    /** The version this change is based on; needed when the title or the content changes. */
    version: z.number().int().positive().optional(),
    title: z.string().trim().min(1).max(DOC_TITLE_MAX).optional(),
    content: z.string().max(DOC_CONTENT_MAX).optional(),
    change_note: z.string().trim().max(CHANGE_NOTE_MAX).optional(),
    /** Move into a folder, or to the root of `space` with null. */
    folder_id: idField.nullable().optional(),
    space: z.enum(KNOWLEDGE_SPACES).optional(),
    is_template: z.boolean().optional(),
    tags: tagsField.optional(),
    meta: docMetaSchema.optional(),
  })
  .refine((input) => (input.title === undefined && input.content === undefined) || input.version !== undefined, {
    message: 'Send the version the change is based on.',
    path: ['version'],
  });
export type UpdateDocInput = z.infer<typeof updateDocInputSchema>;

export const docVersionSchema = z.object({
  version: z.number().int(),
  title: z.string(),
  change_note: z.string(),
  created_by: memberRefSchema.nullable(),
  /** The Agent that wrote it for `created_by`, when one did. */
  agent: agentRefSchema.nullable(),
  created_at: isoTime,
});
export type DocVersion = z.infer<typeof docVersionSchema>;
export const docVersionDetailSchema = docVersionSchema.extend({ content: z.string() });
export type DocVersionDetail = z.infer<typeof docVersionDetailSchema>;

/** Restoring writes a new version with the old title and content; `version` is the doc's current one. */
export const restoreVersionInputSchema = z.object({ version: z.number().int().positive() });

export const diffQuerySchema = z.object({
  /** Default: the version before `to`. */
  from: z.coerce.number().int().positive().optional(),
  /** Default: the current version. */
  to: z.coerce.number().int().positive().optional(),
  mode: z.enum(DIFF_MODES).default('line'),
});
export const diffPartSchema = z.object({ op: z.enum(['equal', 'insert', 'delete']), text: z.string() });
export const diffHunkSchema = z.object({
  /** Where the hunk starts in each version, from line 1. */
  from_line: z.number().int(),
  to_line: z.number().int(),
  /** Whole lines (ending in a newline) in line mode, words and spaces in word mode. */
  parts: z.array(diffPartSchema),
});
export const docDiffSchema = z.object({
  from: z.number().int(),
  to: z.number().int(),
  mode: z.enum(DIFF_MODES),
  /** Set when the title changed. */
  title: z.object({ from: z.string(), to: z.string() }).nullable(),
  /** Lines in line mode, words in word mode. */
  added: z.number().int(),
  removed: z.number().int(),
  hunks: z.array(diffHunkSchema),
  /** Some hunks were left out to keep it small. */
  truncated: z.boolean(),
});
export type DocDiff = z.infer<typeof docDiffSchema>;

export const commentSchema = z.object({
  id: z.string(),
  target_type: z.enum(COMMENT_TARGETS),
  target_id: z.string(),
  /** Markdown; `[@Name](member:<id>)` mentions. */
  body: z.string(),
  /** The members it mentions. */
  mentions: z.array(z.string()),
  created_by: memberRefSchema.nullable(),
  /** The Agent that wrote it for `created_by`, when one did. */
  agent: agentRefSchema.nullable(),
  /** The reader wrote it: they may edit or delete it. */
  mine: z.boolean(),
  edited: z.boolean(),
  created_at: isoTime,
  updated_at: isoTime,
});
export type KnowledgeComment = z.infer<typeof commentSchema>;
export const commentInputSchema = z.object({ body: z.string().trim().min(1).max(COMMENT_BODY_MAX) });
export type CommentInput = z.infer<typeof commentInputSchema>;

/** The same audience entries as a public Agent's: members, groups, or the whole workspace. */
export const knowledgeShareSchema = z.object({
  type: z.enum(AUDIENCE_TYPES),
  /** Null for the workspace. */
  id: z.string().nullable(),
  /** The member's or group's name; empty for the workspace. */
  name: z.string(),
  role: z.enum(KNOWLEDGE_SHARE_ROLES),
});
export type KnowledgeShare = z.infer<typeof knowledgeShareSchema>;
export const knowledgeSharesSchema = z.object({
  items: z.array(knowledgeShareSchema),
  /** From the folders above it. A share here can widen these, never narrow them. */
  inherited: z.array(knowledgeShareSchema.extend({ folder_id: z.string(), folder_name: z.string() })),
});
export type KnowledgeShares = z.infer<typeof knowledgeSharesSchema>;
/** Replaces the item's own shares. Only the owner of a personal item shares it; team items are everyone's. */
export const shareInputSchema = z.object({
  items: z
    .array(
      z
        .object({
          type: z.enum(AUDIENCE_TYPES),
          id: idField.optional(),
          role: z.enum(KNOWLEDGE_SHARE_ROLES),
        })
        .refine((entry) => (entry.type === 'workspace') === (entry.id === undefined), {
          message: 'A member or group needs its id; the workspace has none.',
        }),
    )
    .max(100),
});
export type ShareInput = z.infer<typeof shareInputSchema>;

export const docPresenceSchema = z.object({
  member_id: z.string(),
  name: z.string(),
  state: z.enum(PRESENCE_STATES),
  since: isoTime,
});
export type DocPresence = z.infer<typeof docPresenceSchema>;
export const docPresenceListSchema = z.object({ items: z.array(docPresenceSchema) });
/** A heartbeat every 20 seconds or so; someone silent for a minute is gone. */
export const presenceInputSchema = z.object({ state: z.enum(PRESENCE_STATES) });

export const knowledgeFileSchema = knowledgeItemSchema.extend({
  /** A picture or file that belongs to a doc (pasted into it) rather than to the tree. */
  doc_id: z.string().nullable(),
  preview: z.enum(KNOWLEDGE_PREVIEWS),
  /** The bytes, for this member and for an hour or two. Web pages and SVG always download. */
  url: z.string(),
  expires_at: isoTime,
  created_at: isoTime,
});
export type KnowledgeFile = z.infer<typeof knowledgeFileSchema>;
/** Sent as multipart/form-data next to the `file` field: a folder, the root of a space, or a doc. */
export const knowledgeUploadFieldsSchema = z.object({
  folder_id: idField.optional(),
  space: z.enum(KNOWLEDGE_SPACES).optional(),
  doc_id: idField.optional(),
});
export const updateFileInputSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  folder_id: idField.nullable().optional(),
  space: z.enum(KNOWLEDGE_SPACES).optional(),
});
export type UpdateFileInput = z.infer<typeof updateFileInputSchema>;

export const knowledgeSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  space: z.enum(KNOWLEDGE_SCOPES).optional(),
  /** Only inside this folder. */
  folder_id: idField.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export const knowledgeSearchHitSchema = z.object({
  type: z.enum(['doc', 'file']),
  id: z.string(),
  title: z.string(),
  /** The text around the first match. */
  snippet: z.string(),
  space: z.enum(KNOWLEDGE_SPACES),
  folder_id: z.string().nullable(),
  path: z.array(pathEntrySchema),
  /** Higher is better: words in the title count most, then the summary, then the body. */
  score: z.number(),
  updated_at: isoTime,
});
export type KnowledgeSearchHit = z.infer<typeof knowledgeSearchHitSchema>;
export const knowledgeSearchResultSchema = z.object({ items: z.array(knowledgeSearchHitSchema) });
