# apps/design: v2 prototype

The interactive prototype and component lab for Greenhouse v2. Pages and the lab share one implementation. Specs: docs/product (scope, IA) and docs/design-system (how it looks and behaves).

## Rules
- Mock data only (src/data.ts). Never import business stores, the API client, auth, the database or env secrets.
- The IA follows docs/product/prd.md §6. A module the PRD deleted (workbench, Projects, Automations, Prompt Tasks) never comes back here.
- Colors, type, spacing, radius, strokes, shadows and motion come from @greenhouse/ui/tokens/haven.css. styles.css never hard-codes a value: layout sizes are multiples of the 4px unit (`calc(var(--gh-space-1) * n)`), and a new design value goes into packages/ui/src/tokens/haven.ts plus `pnpm tokens:build`.
- Components come from the kit, @greenhouse/ui/kit (packages/ui/src/kit, styles in kit.css). This app keeps only its compositions (PageFrame, the 需要你 cards, RecordEditor, MiniChart, Steps in components.tsx; chat.tsx; details.tsx; shell.tsx) and NativeSelect, which is only for the preview toolbar and the scenario switch.
- A missing or wrong component state is fixed in the kit with its unit test (packages/ui/src/kit/__tests__), never patched here; do not style gh- classes beyond placing them in a layout.
- The product window carries the kit's hooks: data-theme, data-narrow (the phone layout) and data-floating-boundary (floating panels, overlays and toasts stay inside it). The app is wrapped in KitProvider locale="zh".
- Drawer actions go in OverlayActions (the fixed footer); confirmations go through confirm() in the design context, which opens a ConfirmDialog.
- Every sidebar row with actions gets a context menu built in useRowMenus (shell.tsx); its page header "⋯" uses the same builder.
- Reply cards always go through ChatCard: title row with the status badge at the far right; process cards fold; decisions put buttons bottom right.
- Copy follows docs/design-system/content.md: no description line under titles, extra explanation in a HelpHint, nothing below 12px.
- Every component supports both themes, keyboard focus, disabled with a reason, loading and failure, and prefers-reduced-motion.
- Do not turn this app into a second production framework: anything reusable belongs in the kit.

## Commands and tests
- `pnpm design:dev` (127.0.0.1:4518), `pnpm design:build`, `pnpm test:design-ui`.
- Browser tests live in e2e/*.e2e.ts (not *.spec.ts, so the root Vitest run skips them). When another checkout holds 4518, run with DESIGN_PORT=<port>.
- Update docs/design-system, the kit, this app's README.md and the lab together when a component or state changes.
