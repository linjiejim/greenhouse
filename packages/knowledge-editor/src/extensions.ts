/**
 * Canonical Tiptap schema extensions for knowledge-base documents.
 *
 * SINGLE SOURCE OF TRUTH — shared by the web editor (apps/web) and the
 * server-side Markdown→JSON converter (apps/api). They MUST stay identical:
 * `content_json` generated on the server has to parse against the exact schema
 * the browser editor renders, or the editor will silently drop/transform nodes.
 *
 * UI-only extensions (e.g. Placeholder) are intentionally excluded here — they
 * add no schema nodes/marks. The web editor appends those on top separately.
 */

import StarterKit from '@tiptap/starter-kit';
import Typography from '@tiptap/extension-typography';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import type { Extensions } from '@tiptap/core';

export function knowledgeEditorExtensions(): Extensions {
  // StarterKit v3 already bundles Link (and Heading) — configure them through it
  // rather than adding a second Link extension (which warns about duplicates and
  // can shadow config). Typography is NOT bundled, so it stays separate.
  //
  // Table + Image are part of the schema because agents legitimately write GFM
  // tables and images via knowledge_mutation. Without these nodes, generateJSON
  // silently DROPPED them from content_json and a human save then erased them
  // from the canonical Markdown (audit 2026-06-10 defect #5).
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false, autolink: true, linkOnPaste: true },
    }),
    Typography,
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Image.configure({ inline: false }),
  ];
}
