/**
 * Knowledge Mutation tool — bounded writes for team/personal knowledge docs.
 *
 * This keeps knowledge writes separate from knowledge_query. It is only reachable
 * via the cloud proxy mutating allowlist, which requires confirm:true and audits
 * every call.
 */

import { randomUUID } from 'node:crypto';
import { tool } from 'ai';
import { z } from 'zod';
import { safeJsonParse } from '@greenhouse/utils/json';
import { toErrorMessage } from '@greenhouse/utils/error';
import { markdownToTiptapJson } from '@greenhouse/knowledge-editor/markdown';
import { entityUrl } from '@greenhouse/types/entity-links';
import type { DatabaseProvider } from '@greenhouse/db';
import { defineTool, type ToolMeta } from './define.js';
import { resolveKbAccess, canWrite, canArchive } from '../knowledge/access.js';
import { resolveKbFolderPath } from '../knowledge/folders.js';
// Shared with knowledge_query's mode=outline|section: read and write must
// address the same span, or a model edits something other than what it read.
import { replaceSection } from '../knowledge/sections.js';
import { runKnowledgeAgentAction } from '../platform/knowledge/agent-adapter.js';
import type { KnowledgeActionId } from '../platform/knowledge/adapter.js';

/** Exported for the browser-extension contract test: the panel's knowledge saves must parse under it. */
export const knowledgeMutationSchema = z.object({
  action: z
    .enum([
      'knowledge.create_doc',
      'knowledge.update_doc',
      'knowledge.patch_doc',
      'knowledge.append_doc',
      'knowledge.update_section',
      'knowledge.archive_doc',
      'knowledge.restore_version',
      'knowledge.share_doc',
      'knowledge.unshare_doc',
    ])
    .describe('Bounded knowledge mutation action.'),
  scope: z.enum(['team', 'personal']).default('team').describe('Team shared doc or current-user personal doc.'),
  doc_id: z
    .string()
    .optional()
    .describe('Document id. Required for update/archive/restore/share; optional for create.'),
  title: z.string().optional().describe('Document title.'),
  content: z
    .string()
    .optional()
    .describe(
      'Markdown. For create/update_doc: the full body. For append_doc: text to append. For update_section: the new section body.',
    ),
  content_json: z.string().optional().describe('Optional editor JSON string.'),
  find: z
    .string()
    .optional()
    .describe(
      'patch_doc: the exact existing substring to replace. MUST occur exactly once in the doc — include surrounding context to disambiguate.',
    ),
  replace: z.string().optional().describe('patch_doc: replacement for `find`. Empty string deletes the matched text.'),
  heading: z
    .string()
    .optional()
    .describe(
      'update_section: the heading whose section body to replace, e.g. "## Install" or "Install". MUST match exactly one heading.',
    ),
  folder: z
    .string()
    .optional()
    .describe(
      'Folder path to file the doc into, e.g. "指南/场景示例" ("/" = root). For create and content-update actions. The folder must already exist (team docs go into team folders, personal docs into your own).',
    ),
  tags: z.array(z.string()).optional(),
  summary: z
    .string()
    .optional()
    .describe(
      'One or two sentences on what this doc covers and which questions it answers. Supply it whenever you write or substantially rewrite a doc: it is indexed at a higher weight than the body, so it is what makes the doc findable later by someone phrasing the question differently. Omitting it on a content change clears the old one.',
    ),
  version: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Version number to roll back to (required for knowledge.restore_version; from knowledge_query versions).',
    ),
  share_role: z
    .enum(['reader', 'editor'])
    .optional()
    .describe('Role to grant on share_doc (default reader). reader = read-only, editor = read+write.'),
  share_targets: z
    .array(z.string())
    .optional()
    .describe('share/unshare targets: user ids, or "group:<id>" for a whole group. Personal docs only.'),
  change_reason: z.string().optional().describe('Reason stored in version history for updates.'),
  meta: z.record(z.string(), z.unknown()).optional(),
});

type KnowledgeMutationInput = z.infer<typeof knowledgeMutationSchema>;

export interface KnowledgeMutationContext {
  userId: string;
}

function makeDocId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${slug || 'doc'}-${randomUUID().slice(0, 8)}`;
}

function docScope(scope: 'team' | 'personal') {
  return {
    dbScope: 'shared',
    visibility: scope === 'team' ? 'team' : 'private',
  } as const;
}

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'knowledge_mutation',
  name: 'Knowledge Mutation',
  brief: 'Create/update/patch/archive/restore/share team or personal knowledge docs with confirmation',
  description: `Controlled knowledge mutation tool. Actions: knowledge.create_doc, knowledge.update_doc (replace the FULL body), knowledge.patch_doc (targeted edit — replace an exact unique substring via find/replace; prefer this for small edits to long docs instead of resending the whole body), knowledge.append_doc (add content to the end via the content field), knowledge.update_section (replace one Markdown section's body, addressed by its heading), knowledge.archive_doc, knowledge.restore_version (roll back to a prior version number from knowledge_query versions), and knowledge.share_doc / knowledge.unshare_doc (grant or revoke access to a PERSONAL doc for specific users or groups via share_targets = user ids or "group:<id>", with share_role reader|editor — owner only).

For large docs, patch_doc/append_doc/update_section are strongly preferred over update_doc: you send only the change, not the entire document, which is cheaper and avoids accidentally altering untouched sections. find (patch_doc) and heading (update_section) must match exactly once — read the doc with knowledge_query first to copy the exact text.

Editors (granted editor role) may create/update/patch/append/restore; archiving and sharing are owner-only. Every change is recorded in version history and every call requires explicit user confirmation via the cloud proxy (confirm:true) and is audited. Always read/search existing docs with knowledge_query first (use action=versions before a restore), explain the intended change, and wait for user approval before calling. Personal scope is limited to the current user's own documents. Use personal docs to durably capture the user's business/project context and preferences so it can be recalled in future sessions — and share them with specific colleagues or groups when context should be shared.`,
  category: 'team',
  is_global: true,
  surface: { proxy: 'write', mcp: 'knowledge' },
  icon: 'BookPlus',
  sort_order: 30,
};

export function createKnowledgeMutationTool(db: DatabaseProvider, ctx: KnowledgeMutationContext) {
  const legacyTool = tool({
    description: meta.description,
    inputSchema: knowledgeMutationSchema,
    execute: async (input: KnowledgeMutationInput) => {
      try {
        const scope = input.scope ?? 'team';
        const { dbScope, visibility } = docScope(scope);
        // Both team and personal docs live in the 'shared' scope. Personal
        // ownership is tracked by owner_user_id + visibility='private'.

        if (input.action === 'knowledge.create_doc') {
          if (!input.title) return { action: input.action, error: 'title is required' };
          if (!input.content) return { action: input.action, error: 'content is required' };

          const docId = input.doc_id || makeDocId(input.title);
          const existing = await db.knowledgeBase.get(docId, dbScope);
          if (existing) return { action: input.action, error: `Document already exists: ${docId}` };

          let folderId: number | null = null;
          let folderPath: string | undefined;
          if (input.folder !== undefined) {
            const folder = await resolveKbFolderPath(db, input.folder, { visibility, ownerUserId: ctx.userId });
            if (!folder.ok) return { action: input.action, error: folder.error };
            folderId = folder.folderId;
            if (folder.folderId != null) folderPath = folder.path;
          }

          const doc = await db.knowledgeBase.create({
            doc_id: docId,
            scope: dbScope,
            title: input.title,
            content: input.content,
            // Markdown is canonical; derive Tiptap JSON from it unless the caller
            // supplied editor JSON explicitly, so the editor renders fresh content.
            content_json: input.content_json ?? markdownToTiptapJson(input.content),
            visibility,
            folder_id: folderId,
            status: 'published',
            tags: input.tags,
            meta: input.meta,
            owner_user_id: ctx.userId,
            created_by: ctx.userId,
            updated_by: ctx.userId,
            _summary: input.summary,
          });
          // Register this doc's outgoing canonical links so backlinks stay correct
          // for agent-authored docs too (the HTTP route does the same on save).
          await db.knowledgeBase.rebuildOutlinks(doc.id, input.content);
          return {
            action: input.action,
            status: 'created',
            scope,
            document: {
              id: doc.id,
              doc_id: doc.doc_id,
              url: entityUrl({ kind: 'kb_doc', id: doc.id, slug: doc.doc_id }),
              title: doc.title,
              visibility: doc.visibility,
              ...(folderPath ? { folder: folderPath } : {}),
            },
          };
        }

        // All remaining actions (update / archive / restore / share) operate on an
        // existing, non-archived doc the caller is allowed to write.
        if (!input.doc_id) return { action: input.action, error: 'doc_id is required' };
        const existing = await db.knowledgeBase.get(input.doc_id, dbScope);
        if (!existing || existing.status === 'archived' || existing.visibility !== visibility) {
          return { action: input.action, error: `Document not found: ${input.doc_id}` };
        }
        // Access folds in owner / team-collaborative / editor+reader grants (incl. groups).
        const access = await resolveKbAccess(db, existing, ctx.userId);
        if (!canWrite(access)) {
          return { action: input.action, error: `Document not found: ${input.doc_id}` };
        }

        if (input.action === 'knowledge.share_doc' || input.action === 'knowledge.unshare_doc') {
          if (access !== 'owner') {
            return { action: input.action, error: 'Only the document owner can manage sharing' };
          }
          if (scope !== 'personal' || existing.visibility !== 'private') {
            return { action: input.action, error: 'Only personal (private) docs can be shared with specific people' };
          }
          const targets = input.share_targets ?? [];
          if (targets.length === 0) return { action: input.action, error: 'share_targets is required' };
          if (input.action === 'knowledge.share_doc') {
            const role = input.share_role ?? 'reader';
            for (const t of targets) {
              if (t === ctx.userId) continue; // owner already has full access
              await db.knowledgeShares.grant(existing.id, t, role, ctx.userId);
            }
            return { action: input.action, status: 'shared', scope, doc_id: existing.doc_id, role, targets };
          }
          for (const t of targets) await db.knowledgeShares.revoke(existing.id, t);
          return { action: input.action, status: 'unshared', scope, doc_id: existing.doc_id, targets };
        }

        if (input.action === 'knowledge.archive_doc') {
          if (!canArchive(access, existing)) {
            return { action: input.action, error: 'Only the document owner can archive it' };
          }
          const ok = await db.knowledgeBase.archive(existing.id, ctx.userId);
          if (!ok) return { action: input.action, error: `Document not found: ${input.doc_id}` };
          return {
            action: input.action,
            status: 'archived',
            scope,
            document: { id: existing.id, doc_id: existing.doc_id, title: existing.title },
          };
        }

        if (input.action === 'knowledge.restore_version') {
          if (!input.version) return { action: input.action, error: 'version is required' };
          const restored = await db.knowledgeBase.restoreVersion(existing.id, input.version, ctx.userId);
          if (!restored) return { action: input.action, error: `Version not found: v${input.version}` };
          return {
            action: input.action,
            status: 'restored',
            scope,
            restored_from_version: input.version,
            document: {
              id: restored.id,
              doc_id: restored.doc_id,
              title: restored.title,
              visibility: restored.visibility,
            },
          };
        }

        // Content-mutating actions converge here. patch/append/update_section derive
        // the new FULL Markdown from the existing body (so the caller only sends the
        // delta, not the whole long doc); update_doc takes the full body as-is.
        let newContent: string | undefined;
        let defaultReason = 'Updated by cloud knowledge_mutation tool';

        if (input.action === 'knowledge.patch_doc') {
          if (!input.find) return { action: input.action, error: 'find is required' };
          const count = existing.content.split(input.find).length - 1;
          if (count === 0) return { action: input.action, error: 'find text not found in document' };
          if (count > 1) {
            return {
              action: input.action,
              error: `find text is not unique (${count} matches) — add more surrounding context`,
            };
          }
          newContent = existing.content.replace(input.find, input.replace ?? '');
          defaultReason = 'Patched via knowledge_mutation';
        } else if (input.action === 'knowledge.append_doc') {
          if (!input.content) return { action: input.action, error: 'content is required' };
          const base = existing.content.replace(/\s+$/, '');
          newContent = base ? `${base}\n\n${input.content.trim()}\n` : `${input.content.trim()}\n`;
          defaultReason = 'Appended via knowledge_mutation';
        } else if (input.action === 'knowledge.update_section') {
          if (!input.heading) return { action: input.action, error: 'heading is required' };
          if (input.content === undefined) return { action: input.action, error: 'content is required' };
          const result = replaceSection(existing.content, input.heading, input.content);
          if (!result.ok) return { action: input.action, error: result.error };
          newContent = result.content;
          defaultReason = 'Section updated via knowledge_mutation';
        } else {
          // knowledge.update_doc — full-body or metadata-only update.
          newContent = input.content;
        }

        // Optional folder move. Resolved against the DOC OWNER's tree (matches the
        // HTTP route's validateFolderTarget): an editor moving a doc shared with
        // them files it within the owner's folders, never their own.
        let folderMove: { folderId: number | null; path: string } | undefined;
        if (input.folder !== undefined) {
          const folder = await resolveKbFolderPath(db, input.folder, {
            visibility,
            ownerUserId: existing.owner_user_id ?? ctx.userId,
          });
          if (!folder.ok) return { action: input.action, error: folder.error };
          folderMove = { folderId: folder.folderId, path: folder.path };
        }

        // Keep Tiptap JSON in step with Markdown: whenever the body changed (and no
        // editor JSON was passed), regenerate it so the editor never shows stale content.
        const contentJson =
          input.content_json ?? (newContent !== undefined ? markdownToTiptapJson(newContent) : undefined);

        const updated = await db.knowledgeBase.update(
          existing.id,
          {
            title: input.title,
            content: newContent,
            content_json: contentJson,
            tags: input.tags,
            meta: input.meta,
            _summary: input.summary,
            ...(folderMove ? { folder_id: folderMove.folderId } : {}),
          },
          ctx.userId,
          input.change_reason ?? defaultReason,
        );
        if (!updated) return { action: input.action, error: `Document not found: ${input.doc_id}` };
        // Content-changing actions must refresh outlinks, exactly like the HTTP save
        // path — otherwise agent edits silently desync the backlink graph.
        if (newContent !== undefined) await db.knowledgeBase.rebuildOutlinks(updated.id, updated.content);
        return {
          action: input.action,
          status: 'updated',
          scope,
          document: {
            id: updated.id,
            doc_id: updated.doc_id,
            title: updated.title,
            visibility: updated.visibility,
            tags: safeJsonParse(updated.tags, []),
            ...(folderMove && folderMove.folderId != null ? { folder: folderMove.path } : {}),
          },
        };
      } catch (err) {
        return { action: input.action, error: toErrorMessage(err) };
      }
    },
  });
  const legacyExecute = legacyTool.execute!;
  return {
    ...legacyTool,
    execute: async (input: KnowledgeMutationInput, options: Parameters<typeof legacyExecute>[1]) => {
      let actionId: KnowledgeActionId = 'updateDocument';
      if (input.action === 'knowledge.create_doc') actionId = 'createDocument';
      else if (input.action === 'knowledge.archive_doc') actionId = 'archiveDocument';
      else if (input.action === 'knowledge.restore_version') actionId = 'restoreVersion';
      else if (input.action === 'knowledge.share_doc' || input.action === 'knowledge.unshare_doc') {
        actionId = 'manageShares';
      }
      return runKnowledgeAgentAction(ctx, actionId, input, () => legacyExecute(input, options), input.doc_id);
    },
  };
}

export const knowledgeMutationTool = defineTool({ meta, kind: 'lazy' });
