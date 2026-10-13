---
name: add-agent-tool
description: >-
  Add or change a tool the Greenhouse agent can call: defineTool file, registry entry, lazy
  wiring, proxy and MCP surface, who gets it, guard tests. Use for 加个工具 / 新增 agent tool /
  让模型能调用 xx / 加个 function calling / add an agent tool / let the model call X.
---

Rules live in apps/api/src/AGENTS.md (tool system, proxy, MCP, description and error wording) and in the header of apps/api/src/tools/define.ts. Copy apps/api/src/tools/automation-query.ts (lazy) or apps/api/src/tools/ask-user.ts (static).

Before you start:
- Check the feature's row in docs/product/features.md; never extend a module marked 删除 or 合并 (docs/product/api.md section 4 lists the deleted tools).
- Prefer a new action on an existing query or mutation tool; a parallel tool needs a recorded reason.
- A private or optional module's tool belongs in an extension (apps/api/src/extensions/example/tool.ts).
- A tool that exists only inside Agent conversations is declared in apps/api/src/bots/tools/meta.ts and built by the Bots engine; follow apps/api/src/bots/AGENTS.md instead.

Steps:
1. Write `apps/api/src/tools/<name>.ts`: meta, a zod inputSchema with .describe() on every field, a tool() factory that uses meta.description, and `export const xxxTool = defineTool({ meta, kind, create? })`.
2. Import it and add it to CORE_TOOL_MODULES in apps/api/src/tools/registry.ts; there is no tools/index.ts.
3. A static tool is built by create(db). A lazy tool needs a branch by id in buildLazyServerTools in apps/api/src/agent-runtime/tool-resolution.ts; session-bound tools go inside its `if (sessionId)` block. Core tools never use createLazy.
4. Set meta.surface: leave it out for chat-only tools and for tools that mix reads and writes; proxy 'read', or 'write' (confirm-gated) for /api/agent; `mcp: '<group>'` only together with a proxy tier; workbench and unattendedReplaySafe only as define.ts allows.
5. Decide who gets it: is_global true gives it to every internal user; a tool of a flagged or app module goes into that point's toolIds in apps/api/src/platform/feature-points.ts; any other tool is granted per user under Advanced tools. Set builtin only by the bar in define.ts.
6. Update the guard tests to the intended sets: `apps/api/src/tools/__tests__/surface-derivation.test.ts`, `apps/api/src/tools/__tests__/description-budget.test.ts` (shorten the description before raising the budget) and `apps/api/src/platform/__tests__/feature-point-parity.test.ts`.
7. Test each action, input validation and the permission paths in `apps/api/src/tools/__tests__/` or tests/api/.
8. Optional on the web: an icon in TOOL_ICONS (apps/web/src/lib/icons.ts) and a result card in apps/web/src/components/tool-call/body-artifacts.tsx.
9. Run the quality-gate skill, with `pnpm test:e2e:ci` when the surface changed.
10. If the change ships or removes a feature, set its row in docs/product/features.md (status and PR) in the same PR.

Red lines:
- The description and every error message are prompt text: claim only what works and follow the wording rules in apps/api/src/AGENTS.md.
- Listing the tool in sprouty.yaml enables nothing; the preset runs on the user's whole allowed tool set.

v2: tools move to `apps/api/src/modules/<domain>/tools.ts`, call the same service as the HTTP route and use the names in docs/product/api.md section 4.
