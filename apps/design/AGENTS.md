# apps/design: v2 prototype

The interactive prototype and component lab for Greenhouse v2. Pages and the lab share one implementation. Specs: docs/product (scope, IA) and docs/design-system (how it looks and behaves).

## Rules
- Mock data only (src/data.ts). Never import business stores, the API client, auth, the database or env secrets.
- The IA follows docs/product/prd.md §6. A module the PRD deleted (workbench, Projects, Automations, Prompt Tasks) never comes back here.
- Colors, type, spacing, radius, shadows and motion come from @greenhouse/ui/tokens/haven.css. styles.css may alias them but never hard-codes a value; a new value goes into packages/ui/src/tokens/haven.ts plus `pnpm tokens:build`.
- Product controls use the local kit: Select, MultiSelect, DatePicker, DateRangePicker (pickers.tsx), Menu and useContextMenu (popover.tsx), ChatCard and the rest (components.tsx). NativeSelect is only for the preview toolbar and the scenario switch.
- Floating panels are position fixed, stay inside .product-window and close on an outside pointer, outside scroll, Escape or Tab. Escape inside a panel must not close the drawer behind it.
- Every sidebar row with actions gets a context menu built in useRowMenus (shell.tsx); its page header "⋯" uses the same builder.
- Reply cards always go through ChatCard: title row with the status badge at the far right; process cards fold; decisions put buttons bottom right.
- Copy follows docs/design-system/content.md: no description line under titles, extra explanation in a HelpHint, nothing below 12px.
- Every component supports both themes, keyboard focus, disabled with a reason, loading and failure, and prefers-reduced-motion.
- These controls stay prototype-local until roadmap M0.2 moves them into packages/ui; do not turn this app into a second production framework.

## Commands and tests
- `pnpm design:dev` (127.0.0.1:4518), `pnpm design:build`, `pnpm test:design-ui`.
- Browser tests live in e2e/*.e2e.ts (not *.spec.ts, so the root Vitest run skips them). When another checkout holds 4518, run with DESIGN_PORT=<port>.
- Update docs/design-system, this app's README.md and the lab together when a component or state changes.
