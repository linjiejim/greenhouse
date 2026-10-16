import { interpolate } from '@greenhouse/utils/i18n';
import { fence } from '../../security/prompt.js';
/**
 * The knowledge base for Agents (KNOW-16, AGNT-17), through the same service as the routes and
 * with the asker's rights. Reading cites the doc under the reply. Writing waits for the member's
 * approval, except inside the Agent's own private reference folder, which only it and its owner
 * see. Edits keep versions and record the Agent as the writer.
 */

import { z } from 'zod';
import {
  CHANGE_NOTE_MAX,
  COMMENT_BODY_MAX,
  DOC_CONTENT_MAX,
  DOC_TITLE_MAX,
  docHref,
  type PathEntry,
} from '@greenhouse/contract';
import { ApiError } from '../../http/errors.js';
import type { As, KnowledgeService } from '../../modules/knowledge/service.js';
import { spaceLabel, accessLabel } from './presentation.js';
import { diffText } from '../../modules/knowledge/diff.js';
import { defineTool, type ToolContext } from './define.js';

/** A doc read at a time; `next_offset` continues it. */
const READ_CHARS = 20_000;
/** What the agent writes in one call. */
const WRITE_CHARS = 200_000;
/** The change an edit card shows. */
const PREVIEW_CHARS = 1_200;

const where = z
  .enum(['team', 'personal', 'shared', 'agent'])
  .describe(
    "team: the team space everyone shares. personal: the member's own space. shared: what others shared with the member. agent: your own private reference folder.",
  );
const writeWhere = z
  .enum(['team', 'personal', 'agent'])
  .describe("team: the team space. personal: the member's own space. agent: your own private reference folder.");

const queryInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('search'),
    query: z.string().trim().min(1).max(200),
    space: where.optional(),
    folder_id: z.string().max(64).optional(),
    limit: z.number().int().min(1).max(20).default(8),
  }),
  z.object({
    action: z.literal('read'),
    doc_id: z.string().max(64),
    offset: z.number().int().min(0).default(0).describe('Where to go on in a long doc: the next_offset you got.'),
  }),
  z.object({
    action: z.literal('list'),
    folder_id: z.string().max(64).optional().describe('A folder to open; else the root of `space`.'),
    space: where.default('team'),
  }),
]);

const mutationInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    title: z.string().trim().min(1).max(DOC_TITLE_MAX),
    content: z.string().max(WRITE_CHARS).describe('Markdown.'),
    folder_id: z.string().max(64).optional().describe('A folder to put it in.'),
    space: writeWhere.optional().describe('Without a folder: the root of this space.'),
    change_note: z.string().max(CHANGE_NOTE_MAX).optional(),
  }),
  z.object({
    action: z.literal('edit'),
    doc_id: z.string().max(64),
    version: z.number().int().positive().describe('The version you read; if someone saved since, read it again.'),
    title: z.string().trim().min(1).max(DOC_TITLE_MAX).optional(),
    content: z.string().max(WRITE_CHARS).optional().describe('The whole new body. For small changes send edits.'),
    edits: z
      .array(z.object({ find: z.string().min(1).max(5_000), replace: z.string().max(WRITE_CHARS) }))
      .min(1)
      .max(20)
      .optional()
      .describe('Replacements; each `find` must appear exactly once in the doc.'),
    change_note: z.string().max(CHANGE_NOTE_MAX).optional().describe('What changed and why, for the history.'),
  }),
  z.object({
    action: z.literal('move'),
    doc_id: z.string().max(64),
    folder_id: z.string().max(64).optional(),
    space: writeWhere.optional(),
  }),
  z.object({
    action: z.literal('comment'),
    doc_id: z.string().max(64),
    body: z.string().trim().min(1).max(COMMENT_BODY_MAX).describe('Markdown; mention someone as [@Name](member:<id>).'),
  }),
]);
type MutationInput = z.infer<typeof mutationInput>;

const pathText = (path: readonly PathEntry[]) => path.map((entry) => entry.name).join(' / ');
const staleMessage = (current: number, read: number) =>
  `Someone saved version ${current} after the version ${read} you read. Read it again and redo the change.`;
const as = (ctx: Pick<ToolContext, 'agent'>): As => ({ agentId: ctx.agent.id });

/**
 * A room is read by people who may not read what the asker's Agent reads for them. There the
 * lines everyone sees (steps under the reply, a card's summary that the decision line repeats)
 * name no doc and no folder; the step rows and the card's details, which only the asker sees,
 * keep them.
 */
const inRoom = (ctx: Pick<ToolContext, 'conversation'>) => ctx.conversation?.kind === 'room';
/**
 * Calls made outside a room, whose step lines may name the doc. `summarize` gets no context, so
 * the call's input marks it; a call not marked (in a room, or not run yet) is summarised without.
 */
const nameable = new WeakSet<object>();
const markNameable = (args: object, ctx: Pick<ToolContext, 'conversation'>) => {
  if (!inRoom(ctx)) nameable.add(args);
};

/** The Agent's own folder answers only for the Agent's owner (no public Agent reaches it). */
function ownAgent(ctx: Pick<ToolContext, 'agent' | 'memberId'>) {
  if (ctx.agent.ownerId !== ctx.memberId) throw new Error("Only your owner's turns can use your reference folder.");
}

export function knowledgeTools(knowledge: KnowledgeService) {
  /** Where `space` and `folder_id` point: a folder, or the root of a space. */
  async function target(
    args: { folder_id?: string | undefined; space?: string | undefined },
    ctx: Pick<ToolContext, 'agent' | 'memberId'>,
    create: boolean,
  ): Promise<{ folderId: string | null; space: 'team' | 'personal' | undefined; ownFolder: boolean }> {
    if (args.folder_id) {
      return {
        folderId: args.folder_id,
        space: undefined,
        ownFolder:
          ctx.agent.ownerId === ctx.memberId && (await knowledge.inAgentFolder('folder', args.folder_id, ctx.agent.id)),
      };
    }
    if (args.space === 'agent') {
      ownAgent(ctx);
      const folder = await knowledge.agentFolder(ctx.agent, create);
      if (folder?.archivedAt) throw new Error('The member archived your reference folder; ask them to restore it.');
      return { folderId: folder?.id ?? null, space: 'personal', ownFolder: true };
    }
    return {
      folderId: null,
      space: args.folder_id ? undefined : args.space === 'team' ? 'team' : 'personal',
      ownFolder: false,
    };
  }

  /** A short name for a place, in the member's language. */
  async function placeName(
    place: { folderId: string | null; space: 'team' | 'personal' | undefined; ownFolder: boolean },
    ctx: ToolContext,
  ): Promise<string> {
    const zh = ctx.locale === 'zh';
    if (place.folderId) {
      const folder = await knowledge.folder(ctx.memberId, place.folderId, as(ctx));
      return pathText([...folder.path, { id: folder.id, name: folder.name }]);
    }
    if (place.ownFolder)
      return zh
        ? interpolate('zh', '{name} 的参考文件夹', { name: ctx.agent.name })
        : `${ctx.agent.name}'s reference folder`;
    if (place.space === 'team') return zh ? '团队知识库' : 'the team space';
    return zh ? '你的个人空间' : 'your personal space';
  }

  /** What an edit makes of the doc now: the whole new content. */
  function applyEdits(content: string, edits: ReadonlyArray<{ find: string; replace: string }>): string {
    let next = content;
    for (const edit of edits) {
      const first = next.indexOf(edit.find);
      if (first < 0) throw new Error(`Not found in the doc: ${edit.find.slice(0, 80)}`);
      if (next.indexOf(edit.find, first + 1) >= 0) {
        throw new Error(`Found more than once; include more of the text around it: ${edit.find.slice(0, 80)}`);
      }
      next = next.slice(0, first) + edit.replace + next.slice(first + edit.find.length);
    }
    return next;
  }

  /** The change as a few lines, for the approval card. */
  function preview(before: string, after: string): string {
    // The diff refuses fine work past its budget (a big rewrite shows as counts only), and the
    // lines stop once the card has enough.
    const { hunks, added, removed } = diffText(before, after, 'line');
    let text = `+${added} −${removed}`;
    for (const part of hunks.flatMap((hunk) => hunk.parts)) {
      if (text.length > PREVIEW_CHARS) break;
      if (part.op === 'equal') continue;
      const sign = part.op === 'insert' ? '+' : '-';
      text += part.text
        .slice(0, PREVIEW_CHARS)
        .replace(/\n$/, '')
        .split('\n')
        .map((line) => `\n${sign} ${line}`)
        .join('');
    }
    return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
  }

  const query = defineTool({
    name: 'knowledge_query',
    publicAgent: true,
    description:
      'Read the knowledge base the member can read: search (full text, Chinese and English, best first), read a doc (Markdown, with its version), or list a folder or the root of a space. Docs you read are shown under your reply as sources. Link docs in your reply as [Title](#/knowledge/<doc id>). Your private reference folder is space "agent".',
    input: queryInput,
    risk: 'read',
    idempotent: true,
    private: true,
    // Docs are written by other people: their text is information, never instructions.
    taints: true,
    available: (ctx) => ctx.modules.knowledge && (!ctx.publicAgent || ctx.publicAgent.folderIds.length > 0),
    async turnContext(ctx) {
      if (ctx.publicAgent || !ctx.manifest.folder_ids?.length) return null;
      const attached = [];
      for (const id of ctx.manifest.folder_ids) {
        try {
          const folder = await knowledge.folder(ctx.memberId, id);
          attached.push({ id, name: folder.name });
        } catch {
          /* Removed folders stop appearing. */
        }
      }
      return attached.length
        ? `Attached knowledge folders (reference data): ${fence(JSON.stringify(attached), 4000)}`
        : null;
    },
    async execute(args, ctx) {
      markNameable(args, ctx);
      if (args.action === 'search') {
        let folderId = args.folder_id;
        let space: 'team' | 'personal' | 'shared' | undefined = args.space === 'agent' ? undefined : args.space;
        if (args.space === 'agent' && !folderId) {
          ownAgent(ctx);
          const own = await knowledge.agentFolder(ctx.agent, false);
          if (!own) return { results: [], note: 'Your reference folder is empty.' };
          folderId = own.id;
          space = undefined;
        }
        const { items } = await knowledge.search(
          ctx.memberId,
          { q: args.query, space, folder_id: folderId, limit: args.limit },
          as(ctx),
        );
        for (const hit of items) {
          if (hit.type === 'doc')
            ctx.cite?.({ kind: 'doc', id: hit.id, title: hit.title, url: docHref(hit.id) }, 'seen');
        }
        return {
          results: items.map((hit) => ({
            type: hit.type,
            id: hit.id,
            title: hit.title,
            where: pathText(hit.path) || spaceLabel(hit.space, ctx.locale),
            space: hit.space,
            space_label: spaceLabel(hit.space, ctx.locale),
            snippet: hit.snippet,
            updated_at: hit.updated_at,
          })),
        };
      }
      if (args.action === 'read') {
        const doc = await knowledge.getDoc(ctx.memberId, args.doc_id, { as: as(ctx), signed: false });
        ctx.cite?.({ kind: 'doc', id: doc.id, title: doc.title, url: docHref(doc.id) }, 'read');
        const end = args.offset + READ_CHARS;
        return {
          id: doc.id,
          title: doc.title,
          link: docHref(doc.id),
          where: pathText(doc.path) || spaceLabel(doc.space, ctx.locale),
          space: doc.space,
          space_label: spaceLabel(doc.space, ctx.locale),
          version: doc.version,
          access: doc.access,
          access_label: accessLabel(doc.access, ctx.locale),
          updated_at: doc.updated_at,
          updated_by: doc.updated_by?.name ?? null,
          content: doc.content.slice(args.offset, end),
          ...(end < doc.content.length ? { next_offset: end, length: doc.content.length } : {}),
        };
      }
      const reader = await knowledge.reader(ctx.memberId, as(ctx));
      if (reader.publicationFolders && !args.folder_id) {
        const items = [];
        for (const id of ctx.agent.publication.folderIds ?? []) {
          if (!reader.publicationFolders.includes(id)) continue;
          const folder = await knowledge.folder(ctx.memberId, id, as(ctx));
          items.push({
            type: 'folder',
            id: folder.id,
            name: folder.name,
            access: 'viewer',
            access_label: accessLabel('viewer', ctx.locale),
          });
        }
        return { items };
      }
      const place = await target(args, ctx, false);
      if (args.space === 'agent' && !args.folder_id && !place.folderId) {
        return { items: [], note: 'Your reference folder is empty.' };
      }
      const items = place.folderId
        ? (await knowledge.folder(ctx.memberId, place.folderId, as(ctx))).children
        : (await knowledge.roots(ctx.memberId, args.space === 'shared' ? 'shared' : (place.space ?? 'team'), as(ctx)))
            .items;
      return {
        items: items.map((item) => ({
          type: item.type,
          id: item.id,
          name: item.name,
          access: item.access,
          access_label: accessLabel(item.access, ctx.locale),
        })),
      };
    },
    summarize: (args, output, locale) => {
      const zh = locale === 'zh';
      if (args.action === 'search')
        return zh ? `搜索知识库：${args.query}` : `Searched the knowledge base: ${args.query}`;
      if (args.action === 'read') {
        const title = nameable.has(args) ? (output as { title?: string } | undefined)?.title : undefined;
        if (!title) return zh ? '读了一篇文档' : 'Read a doc';
        return zh ? `读了《${title}》` : `Read "${title}"`;
      }
      return zh ? '看了知识库目录' : 'Looked through the knowledge base';
    },
  });

  /** Whether the call stays inside this Agent's own folder (and the doc is there and readable). */
  async function ownFolderOnly(args: MutationInput, ctx: Omit<ToolContext, 'stepId' | 'raise' | 'endTurn'>) {
    // What a card would name must be there for the member, and an edit must still apply: a card
    // that can only fail helps nobody, so those calls are refused before one is raised.
    if ((args.action === 'create' || args.action === 'move') && args.folder_id) {
      await knowledge.folder(ctx.memberId, args.folder_id, as(ctx));
    }
    if (args.action === 'create') return (await target(args, ctx, false)).ownFolder;
    const doc = await knowledge.getDoc(ctx.memberId, args.doc_id, { as: as(ctx), signed: false });
    if (args.action === 'edit') {
      if (doc.version !== args.version) throw new Error(staleMessage(doc.version, args.version));
      const after = args.edits ? applyEdits(doc.content, args.edits) : args.content;
      if (after === undefined && args.title === undefined) throw new Error('Send content, edits or a title.');
      if (after !== undefined && after.length > DOC_CONTENT_MAX) {
        throw new Error(
          `The doc would be ${after.length} characters, over the limit of ${DOC_CONTENT_MAX}. Change less of it, or split it into more docs.`,
        );
      }
    }
    const inside =
      ctx.agent.ownerId === ctx.memberId && (await knowledge.inAgentFolder('doc', args.doc_id, ctx.agent.id));
    if (args.action === 'move') return inside && (await target(args, ctx, false)).ownFolder;
    return inside;
  }

  const mutation = defineTool({
    name: 'knowledge_mutation',
    async retryTarget(args) {
      return JSON.stringify(
        args.action === 'create'
          ? [args.action, args.title, args.folder_id ?? null, args.space ?? null]
          : [args.action, args.doc_id],
      );
    },
    description:
      'Change the knowledge base with the member\'s rights: create a doc, edit one (read it first and send its version; prefer edits with exact find/replace for small changes), move a doc, or comment on one. Reversible changes visible only to this member or in your private reference folder (space "agent") run immediately with undo. Shared changes use an approval card or the member’s standing approval; outside reads disable standing approvals. Every edit keeps a version that names you. Link other docs as [Title](#/knowledge/<doc id>).',
    input: mutationInput,
    risk: 'write',
    surfaces: ['turn', 'background'],
    guard: () => knowledge.lockWriteScope(),
    available: (ctx) => ctx.modules.knowledge,
    async callRisk(args, ctx) {
      markNameable(args, ctx);
      await ownFolderOnly(args, ctx);
      const source = await knowledge.writeScope(
        ctx.memberId,
        args.action === 'create'
          ? {
              folderId: (await target(args, ctx, false)).folderId ?? undefined,
              space: args.folder_id ? undefined : args.space === 'team' ? 'team' : 'personal',
            }
          : { docId: args.doc_id },
        as(ctx),
      );
      if (args.action !== 'move') return source.tier;
      const doc = await knowledge.getDoc(ctx.memberId, args.doc_id, { as: as(ctx), signed: false });
      const place = await target(args, ctx, false);
      const destination = await knowledge.writeScope(
        ctx.memberId,
        { folderId: place.folderId ?? undefined, space: place.space },
        as(ctx),
      );
      if (doc.space === 'personal' && destination.space === 'team') return 'tier3';
      return source.tier === 'tier1' && destination.tier === 'tier1' ? 'tier1' : 'tier2';
    },
    async approvalScope(args, ctx) {
      // Moving changes the scope itself; approving its old folder cannot authorize the destination.
      if (args.action === 'move') return null;
      const scope = await knowledge.writeScope(
        ctx.memberId,
        args.action === 'create'
          ? {
              folderId: args.folder_id,
              space: args.folder_id ? undefined : args.space === 'team' ? 'team' : 'personal',
            }
          : { docId: args.doc_id },
        as(ctx),
      );
      return scope.folderId
        ? { type: 'folder' as const, id: scope.folderId, actions: [`knowledge.${args.action}`] }
        : null;
    },
    async before(args, ctx) {
      const input = { action: args.action, ...('doc_id' in args ? { doc_id: args.doc_id } : {}) };
      if (args.action === 'create' || args.action === 'comment') return { input };
      const doc = await knowledge.getDoc(ctx.memberId, args.doc_id, { as: as(ctx), signed: false });
      return { input, version: doc.version, folder_id: doc.folder_id, space: doc.space };
    },
    undoResult: (output) => output,
    async undo(args, output, before, ctx) {
      const result = output as {
        created?: string;
        saved?: string;
        moved?: string;
        version?: number;
        commented?: string;
        updated_at?: string;
        folder_id?: string | null;
        space?: 'team' | 'personal';
      };
      const prior = before as { version: number; folder_id: string | null; space: 'team' | 'personal' };
      if (args.action === 'comment') {
        await knowledge.undoComment(ctx.memberId, args.doc_id, result.commented!, result.updated_at!);
        return;
      }
      const docId = args.action === 'create' ? result.created! : args.doc_id;
      await knowledge.lockDoc(ctx.memberId, docId, as(ctx));
      const current = await knowledge.getDoc(ctx.memberId, docId, { as: as(ctx), signed: false });
      const written = result.version ?? prior.version;
      const lineage = ctx.undoRevisions?.get(docId);
      if (current.version !== (lineage?.written === written ? lineage.current : written))
        throw new ApiError(409, 'undo_conflict', 'This doc changed after the write.');
      if (
        (args.action === 'create' || args.action === 'move') &&
        (current.folder_id !== result.folder_id || current.space !== result.space)
      )
        throw new ApiError(409, 'undo_conflict', 'This doc moved after the write.');
      if (args.action === 'create') await knowledge.archiveDoc(ctx.memberId, docId);
      else if (args.action === 'edit')
        await knowledge.restoreVersion(ctx.memberId, docId, prior.version, current.version, as(ctx));
      else await knowledge.updateDoc(ctx.memberId, docId, { folder_id: prior.folder_id, space: prior.space }, as(ctx));
      if (args.action !== 'create')
        ctx.undoRevisions?.set(docId, {
          written: prior.version,
          current: (await knowledge.getDoc(ctx.memberId, docId, { as: as(ctx), signed: false })).version,
        });
    },
    async receipt(args, output, ctx) {
      if (inRoom(ctx)) return ctx.locale === 'zh' ? '修改了文档' : 'Changed a doc';
      const result = output as { created?: string; title?: string };
      const doc = await knowledge.getDoc(ctx.memberId, result.created ?? ('doc_id' in args ? args.doc_id : ''), {
        as: as(ctx),
        signed: false,
      });
      const verb = {
        create: ['新建了', 'Created'],
        edit: ['修改了', 'Edited'],
        move: ['移动了', 'Moved'],
        comment: ['评论了', 'Commented on'],
      }[args.action][ctx.locale === 'zh' ? 0 : 1];
      return ctx.locale === 'zh' ? `${verb}《${doc.title}》` : `${verb} “${doc.title}”`;
    },
    async describe(args, ctx) {
      const zh = ctx.locale === 'zh';
      // In a room the summary (repeated in the decision line everyone sees) names nothing; the
      // details, on the asker's own card, say what and where.
      const room = inRoom(ctx);
      if (args.action === 'create') {
        const place = await placeName(await target(args, ctx, false), ctx);
        return {
          summary: room
            ? zh
              ? '新建一篇文档'
              : 'create a doc'
            : zh
              ? `在 ${place} 新建文档《${args.title}》`
              : `create the doc "${args.title}" in ${place}`,
          details: [
            ...(room ? [{ label: zh ? '标题' : 'Title', value: args.title }] : []),
            { label: zh ? '位置' : 'Where', value: place },
            { label: zh ? '内容' : 'Content', value: args.content.slice(0, 1200), format: 'markdown' as const },
          ],
        };
      }
      const doc = await knowledge.getDoc(ctx.memberId, args.doc_id, { as: as(ctx), signed: false });
      const titled = room ? [{ label: zh ? '文档' : 'Doc', value: doc.title }] : [];
      if (args.action === 'edit') {
        const after = args.edits ? applyEdits(doc.content, args.edits) : (args.content ?? doc.content);
        return {
          summary: room
            ? zh
              ? '修改一篇文档'
              : 'edit a doc'
            : zh
              ? `修改文档《${doc.title}》`
              : `edit the doc "${doc.title}"`,
          details: [
            ...titled,
            ...(args.title && args.title !== doc.title
              ? [{ label: zh ? '新标题' : 'New title', value: args.title }]
              : []),
            { label: zh ? '改动' : 'Changes', value: preview(doc.content, after) },
            { label: zh ? '内容预览' : 'Content preview', value: after.slice(0, 1200), format: 'markdown' as const },
            ...(args.change_note ? [{ label: zh ? '说明' : 'Note', value: args.change_note }] : []),
          ],
        };
      }
      if (args.action === 'move') {
        const place = await placeName(await target(args, ctx, false), ctx);
        return {
          summary: room
            ? zh
              ? '移动一篇文档'
              : 'move a doc'
            : zh
              ? `把《${doc.title}》移到 ${place}`
              : `move "${doc.title}" to ${place}`,
          details: [...titled, { label: zh ? '移到' : 'To', value: place }],
        };
      }
      return {
        summary: room
          ? zh
            ? '评论一篇文档'
            : 'comment on a doc'
          : zh
            ? `评论《${doc.title}》`
            : `comment on "${doc.title}"`,
        details: [
          ...titled,
          { label: zh ? '评论' : 'Comment', value: args.body.slice(0, 1200), format: 'markdown' as const },
        ],
      };
    },
    async execute(args, ctx) {
      markNameable(args, ctx);
      if (args.action === 'create') {
        const place = await target(args, ctx, true);
        const doc = await knowledge.createDoc(
          ctx.memberId,
          {
            title: args.title,
            content: args.content,
            ...(place.folderId ? { folder_id: place.folderId } : { space: place.space ?? 'personal' }),
            ...(args.change_note ? { change_note: args.change_note } : {}),
          },
          as(ctx),
        );
        return {
          created: doc.id,
          title: doc.title,
          link: docHref(doc.id),
          version: doc.version,
          folder_id: doc.folder_id,
          space: doc.space,
          where: pathText(doc.path) || spaceLabel(doc.space, ctx.locale),
          space_label: spaceLabel(doc.space, ctx.locale),
        };
      }
      if (args.action === 'edit') {
        const current = await knowledge.getDoc(ctx.memberId, args.doc_id, { as: as(ctx), signed: false });
        if (current.version !== args.version) throw new Error(staleMessage(current.version, args.version));
        const content = args.edits ? applyEdits(current.content, args.edits) : args.content;
        if (content === undefined && args.title === undefined) throw new Error('Send content, edits or a title.');
        const saved = await knowledge.updateDoc(
          ctx.memberId,
          args.doc_id,
          {
            version: args.version,
            ...(args.title !== undefined ? { title: args.title } : {}),
            ...(content !== undefined ? { content } : {}),
            ...(args.change_note ? { change_note: args.change_note } : {}),
          },
          as(ctx),
        );
        return { saved: saved.id, title: saved.title, version: saved.version, link: docHref(saved.id) };
      }
      if (args.action === 'move') {
        const place = await target(args, ctx, true);
        const moved = await knowledge.updateDoc(
          ctx.memberId,
          args.doc_id,
          place.folderId ? { folder_id: place.folderId } : { folder_id: null, space: place.space ?? 'personal' },
          as(ctx),
        );
        return {
          moved: moved.id,
          where: pathText(moved.path) || spaceLabel(moved.space, ctx.locale),
          space_label: spaceLabel(moved.space, ctx.locale),
          version: moved.version,
          folder_id: moved.folder_id,
          space: moved.space,
        };
      }
      const comment = await knowledge.addComment(ctx.memberId, args.doc_id, args.body, as(ctx));
      return { commented: comment.id, doc_id: args.doc_id, updated_at: comment.updated_at };
    },
    summarize: (args, output, locale) => {
      const zh = locale === 'zh';
      const title = nameable.has(args)
        ? ((output as { title?: string } | undefined)?.title ?? ('title' in args ? args.title : undefined))
        : undefined;
      if (args.action === 'create')
        return title ? (zh ? `新建了《${title}》` : `Created "${title}"`) : zh ? '新建了一篇文档' : 'Created a doc';
      if (args.action === 'edit')
        return title ? (zh ? `修改了《${title}》` : `Edited "${title}"`) : zh ? '修改了一篇文档' : 'Edited a doc';
      if (args.action === 'move') return zh ? '移动了一篇文档' : 'Moved a doc';
      return zh ? '评论了一篇文档' : 'Commented on a doc';
    },
  });

  return [query, mutation];
}
