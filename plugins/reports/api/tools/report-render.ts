/**
 * Report render — write side of report templates (v1.7, MCP group `reports`).
 *
 * Renders structured content against a team template into PDF / Word /
 * PowerPoint in the workspace brand and saves it as a new file in Files (the
 * member's personal shelf unless they name the team shelf or a folder they
 * may write). Over MCP it is a recorded, additive write; in Chat the
 * assistant uses the same implementation. Rendering is local — nothing is
 * metered. Lazy: needs the calling member.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/api/extension-kit';
import type { DatabaseProvider } from '@greenhouse/api/extension-kit';
import { defineTool, type ToolMeta } from '@greenhouse/api/extension-kit';
import { CITE_URL_INSTRUCTION } from '@greenhouse/api/extension-kit';
import { delegatedAgentActor } from '@greenhouse/api/extension-kit';
import { renderReportToFiles } from '../service.js';
import type { ReportToolContext } from './report-templates.js';
const schema = z.object({
  template_id: z.string().describe('The template to follow (report_templates action "list" / "get").'),
  format: z
    .enum(['pdf', 'docx', 'pptx'])
    .optional()
    .describe("Output format; must be one of the template's formats. Default: the template's first format."),
  cover: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Cover fields of the template, e.g. { "title": "...", "period": "2026-10-19 – 10-25" }.'),
  sections: z
    .record(z.string(), z.unknown())
    .describe(
      'Content keyed by section key, each in the shape its section expects: markdown → a Markdown string; bullets → an array of strings; table → { "columns": [...], "rows": [[...]] }; figures → an array of { "label", "value", "note"? }.',
    ),
  file_name: z.string().optional().describe('File name without extension. Default: the title and date or period.'),
  shelf: z
    .enum(['personal', 'team'])
    .optional()
    .describe('Where in Files: your personal shelf (default) or the team shelf.'),
  folder_id: z.coerce.string().optional().describe('A folder on that shelf you may write to.'),
});
type Input = z.infer<typeof schema>;
const meta: ToolMeta = {
  id: 'report_render',
  name: 'Render Report',
  brief: 'Render a report or deck from a team template into Files',
  description: `Render a report or presentation that follows one of the team's templates (report_templates) as PDF, Word (docx) or PowerPoint (pptx) in the workspace brand, and save it as a new file in Files — your personal shelf unless you pass shelf "team" or a folder_id. Read the template first and write each section in the shape it expects; required sections must be present and non-empty and unknown section keys are rejected — a refusal lists every problem so you can fix them all and call again. The result gives the file_id, its Files url and, where the deployment keeps files in object storage, a download link valid for a few minutes. ${CITE_URL_INSTRUCTION}`,
  category: 'team',
  is_global: true,
  icon: 'FileText',
  // A write that only ever adds a file (MCP destructiveHint:false), recorded
  // like every agent write. Local rendering: no provider, nothing metered.
  surface: { proxy: 'write', mcp: 'reports', additiveOnly: true },
  runtime_risk: 'r1',
  sort_order: 41,
};
export function createReportRenderTool(db: DatabaseProvider, ctx: ReportToolContext) {
  const caller = { db, userId: ctx.userId, role: ctx.userRole, actor: delegatedAgentActor({ userId: ctx.userId }) };
  return tool({
    description: meta.description,
    inputSchema: schema,
    execute: async (input: Input) => {
      try {
        return await renderReportToFiles(caller, {
          template_id: input.template_id,
          format: input.format,
          cover: input.cover,
          sections: input.sections,
          file_name: input.file_name,
          shelf: input.shelf,
          folder_id: input.folder_id,
        });
      } catch (error) {
        return { error: `Rendering the report failed: ${toErrorMessage(error)}` };
      }
    },
  });
}
export const reportRenderTool = defineTool({
  meta,
  kind: 'lazy',
  createLazy: ({ db, userId, userRole }) => createReportRenderTool(db, { userId, userRole }),
});
