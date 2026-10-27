# Reports plugin

- Shared plugin rules: [root AGENTS.md](../../AGENTS.md) (Plugins) and [EXTENDING.md](../../EXTENDING.md); this file lists only Reports-specific rules.

## Templates

- A template is a team-required report or deck format: ordered sections (key, title, guidance, required, content kind markdown/bullets/table/figures), cover fields and allowed formats (first = default).
- Template definitions are validated only by `checkReportTemplateDefinition` (`@greenhouse/types/reports`, shared so a client editor uses the same limits) on create, update, preview and seeding.
- Access rules live only in `api/templates.ts`: any internal member publishes team templates or keeps personal drafts; the owner or a super edits/deletes team templates.
- Drafts are visible to their owner only (super included); built-in templates (`owner_user_id = NULL`) are super-edited and never become drafts; only the owner may turn a team template into a draft.
- Deletes are soft (`deleted_at`).
- Built-in templates are seeded only while the workspace has never had a template (`seedIfNeverUsed`: advisory lock, count includes deleted rows), so deleted ones never return; seeding never blocks boot.
- Template changes record platform audit after success (`api/audit.ts`): own changes as `app_id='reports'`, super changes to others' or built-in templates as admin actions under `app_id='platform'`.
- Audit summaries keep name, visibility and owner, never sections; a deleted template's name is shown only to those who could read it.

## Content and rendering

- `checkReportContent` (`api/content.ts`) is the content contract: required sections present and non-empty, unknown section and cover keys refused, shapes and sizes checked, every problem listed at once.
- Refusals spell every issue (path + fix) into the `error` string, because over MCP a refused write reaches the agent as that one string; structured `issues` are extra.
- `report_templates` (`list`/`get`/`validate`) is a replay-safe read; `validate` is a dry run that stores and records nothing.
- `report_render` is an additive write (no confirm round trip) that saves through `uploadCabinetFile`: the member's personal shelf by default, the team shelf or a writable folder on request.
- `api/service.ts` is the single render path for MCP, Agent API, chat and the editor preview (`POST /api/report-templates/preview`, PDF, never stored).
- Rendering is local and pure JS (pdfmake, `docx`, `pptxgenjs`), never a headless browser, and it is never metered.
- pdfmake reads fonts only from its in-memory file system and the logo only as bytes; every URL and disk path is refused, so content is never fetched as a resource.
- Markdown keeps only `http(s)`/`mailto` links and image alt text; images are never fetched.
- Deck slides are cut once in `api/slides.ts` for both PowerPoint and PDF by measured height (real font metrics, wrapped table rows, repeated headers), never by line count.
- The PDF deck is the tighter layout, so plans are measured against it; `api/__tests__/render.test.ts` holds the PDF page count to the plan.
- PDFs embed Noto Sans SC subsets from `assets/fonts/` (rebuild with `scripts/build-report-fonts.sh`); glyphs outside the subset render blank and are named in `warnings`.
- Word and PowerPoint embed no fonts and name `OFFICE_FONT` (Microsoft YaHei).
- Branding comes from the workspace (product name, logo, brand color, default `#2E8B3D`); a logo a format cannot embed is replaced by the product name with a warning, never a failed render.
