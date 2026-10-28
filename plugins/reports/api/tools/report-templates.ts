/**
 * Report templates — read side: the team's required report / deck formats
 * (v1.7, MCP group `reports`).
 *
 * `list` and `get` tell an agent what a report must contain (sections, the
 * guidance for each, the content shape, cover fields, formats); `validate`
 * checks content against a template without rendering or saving anything, so
 * an agent can fix every problem before `report_render` records a write.
 * Lazy: needs the calling member (personal drafts are theirs only).
 */
import { tool } from 'ai';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/api/extension-kit';
import type { DatabaseProvider } from '@greenhouse/api/extension-kit';
import { defineTool, type ToolMeta } from '@greenhouse/api/extension-kit';
import { delegatedAgentActor } from '@greenhouse/api/extension-kit';
import { getTemplate, listTemplates } from '../templates.js';
import { checkReport } from '../service.js';
export const REPORT_CONTENT_SHAPES = {
  markdown: 'a Markdown string (headings, lists, tables, **bold**, links)',
  bullets: 'an array of strings (inline Markdown allowed)',
  table: '{ "columns": ["..."], "rows": [["..."], ...] } — every row has one cell per column',
  figures: 'an array of { "label": "...", "value": "...", "note"?: "..." } — key numbers shown as large tiles',
} as const;
const schema = z.object({
  action: z
    .enum(['list', 'get', 'validate'])
    .describe(
      'list: every template you can use. get: one template with its sections, guidance and content shapes. validate: check content against a template without rendering or saving.',
    ),
  template_id: z.string().optional().describe('get / validate: the template id (from list).'),
  format: z.string().optional().describe('validate: the output format you plan to render (pdf, docx or pptx).'),
  cover: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('validate: cover fields, e.g. { "title": "...", "period": "..." }.'),
  sections: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('validate: content keyed by section key, in the shape each section expects.'),
});
type Input = z.infer<typeof schema>;
const meta: ToolMeta = {
  id: 'report_templates',
  name: 'Report Templates',
  brief: "The team's required formats for reports and presentations",
  description:
    'The team\'s report and presentation templates: the required sections, what to write in each (guidance), the content shape each expects, cover fields and allowed formats. Read a template with action "get" before writing a report, write content in exactly those shapes, then render it with report_render. Use action "validate" to check content first — it lists every missing or malformed part.',
  category: 'team',
  is_global: true,
  icon: 'FileText',
  surface: { proxy: 'read', mcp: 'reports', unattendedReplaySafe: true },
  sort_order: 40,
};
export interface ReportToolContext {
  userId: string;
  userRole: string;
}
export function createReportTemplatesTool(db: DatabaseProvider, ctx: ReportToolContext) {
  const caller = { db, userId: ctx.userId, role: ctx.userRole, actor: delegatedAgentActor({ userId: ctx.userId }) };
  return tool({
    description: meta.description,
    inputSchema: schema,
    execute: async (input: Input) => {
      try {
        switch (input.action) {
          case 'list': {
            const templates = await listTemplates(db, caller);
            return {
              templates: templates.map((t) => ({
                id: t.id,
                name: t.name,
                description: t.description,
                kind: t.kind,
                formats: t.formats,
                visibility: t.visibility,
                owner: t.owner_name,
                version: t.version,
                sections: t.sections.length,
                required_sections: t.sections.filter((s) => s.required).map((s) => s.key),
              })),
            };
          }
          case 'get': {
            if (!input.template_id) return { error: 'template_id is required for get.' };
            const found = await getTemplate(db, caller, input.template_id);
            if (!found.ok) return { error: found.error };
            const t = found.value;
            return {
              template: {
                id: t.id,
                name: t.name,
                description: t.description,
                kind: t.kind,
                formats: t.formats,
                default_format: t.formats[0],
                version: t.version,
                cover_fields: t.cover_fields,
                sections: t.sections.map((s) => ({ ...s, shape: REPORT_CONTENT_SHAPES[s.content] })),
              },
              how_to_render:
                'Call report_render with template_id, an optional format, cover { field: text } and sections { key: content }. ' +
                'Leave out optional sections you have nothing for; required ones must be present and non-empty; unknown keys are rejected.',
            };
          }
          case 'validate': {
            if (!input.template_id) return { error: 'template_id is required for validate.' };
            const checked = await checkReport(caller, {
              template_id: input.template_id,
              format: input.format,
              cover: input.cover,
              sections: input.sections,
            });
            if (!checked.ok) return { valid: false, error: checked.error, issues: checked.issues ?? [] };
            return {
              valid: true,
              format: checked.document.format,
              sections: checked.document.sections.map((s) => s.key),
            };
          }
          default:
            return {
              error: `Unknown action: ${String(
                (
                  input as {
                    action?: unknown;
                  }
                ).action,
              )}`,
            };
        }
      } catch (error) {
        return { error: toErrorMessage(error) };
      }
    },
  });
}
export const reportTemplatesTool = defineTool({
  meta,
  kind: 'lazy',
  createLazy: ({ db, userId, userRole }) => createReportTemplatesTool(db, { userId, userRole }),
});
