/**
 * Canonical Tiptap schema extensions for knowledge-base documents.
 *
 * SINGLE SOURCE OF TRUTH — shared by the web editor (apps/web) and the Node
 * Markdown→JSON converter (markdown.ts) the round-trip tests use. They MUST stay
 * identical: the tests only prove a lossless round-trip for the schema the
 * browser editor really has, or the editor silently drops or transforms nodes.
 *
 * UI-only extensions (e.g. Placeholder) are intentionally excluded here — they
 * add no schema nodes/marks. The web editor appends those on top separately.
 */

import StarterKit from '@tiptap/starter-kit';
import Typography from '@tiptap/extension-typography';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import Mention from '@tiptap/extension-mention';
import type { Extensions } from '@tiptap/core';
import type { SuggestionOptions } from '@tiptap/suggestion';

export interface KnowledgeEditorOptions {
  /**
   * @-mention suggestion behaviour (the dropdown). UI-only — supplied by the web
   * editor. The Node converter omits it; only the NODE schema is shared.
   */
  mentionSuggestion?: Omit<SuggestionOptions, 'editor'>;
}

export function knowledgeEditorExtensions(opts?: KnowledgeEditorOptions): Extensions {
  // StarterKit v3 already bundles Link (and Heading) — configure them through it
  // rather than adding a second Link extension (which warns about duplicates and
  // can shadow config). Typography is NOT bundled, so it stays separate.
  //
  // Table + Image are part of the schema because agents legitimately write GFM
  // tables and images via knowledge_mutation. Without these nodes the editor
  // silently DROPPED them on load and a human save then erased them from the
  // canonical Markdown (audit 2026-06-10 defect #5).
  return [
    StarterKit.configure({
      // h4 is in the schema even though the toolbar only offers H1–H3: the TOC
      // extracts down to h4 and imported Markdown uses it, and a level the schema
      // doesn't know gets silently demoted to a paragraph on the way in.
      heading: { levels: [1, 2, 3, 4] },
      link: { openOnClick: false, autolink: true, linkOnPaste: true },
    }),
    Typography,
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Image.configure({ inline: false }),
    // @-mention NODE is shared so mentions round-trip; the suggestion
    // dropdown is UI-only and injected by the web editor. Attrs: id (member id) +
    // label (name). Serialized to Markdown as `[@label](member:<id>)`.
    Mention.configure({
      HTMLAttributes: { class: 'kb-mention' },
      renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
      ...(opts?.mentionSuggestion ? { suggestion: opts.mentionSuggestion } : {}),
    }),
  ];
}
