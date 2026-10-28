# Agent profile rules

- This directory holds two system profile YAMLs, both internal-only; architecture, tool matrix, i18n and rich output are in [agent-profiles.md](./agent-profiles.md).

## Inventory

- `sprouty.yaml`: the only preset and the default Agent (`DEFAULT_PROFILE_ID`) on `/api/chat`; its `model.id: flash` is only a starting point, since the model is chosen per turn.
- `desktop.yaml`: hidden runtime profile (`access.level: hidden`) for `/api/agent` and `/api/mcp` (`DEFAULT_AGENT_PROFILE_ID` in `routes/agent-tools.ts`, `MCP_PROFILE_ID` in `agent-runtime/mcp-tool-visibility.ts`).
- `desktop` is never listed by `GET /api/profiles` or usable through `/api/chat`/`/api/sessions`; its id is a compatibility name, and renaming it needs a data migration.
- Packs may add or override profiles through `packs.profiles` in greenhouse.config.ts; a later directory wins for the same id.

## Rules

- The inventory has two sources that move together: the YAML files (`loadAllProfiles()`) and the constants in `profile.ts` (`PRESET_PROFILE_IDS`, `DEFAULT_PROFILE_ID`, `CUSTOM_BASE_PROFILE_IDS`).
- A YAML without its constant is an Agent nobody can pick; a constant without its YAML fails at boot with `Profile not found`.
- Built-in YAML profiles use `tools: []`: the runtime derives their tools from the member and active plugins; never pin optional plugin tool ids there.
- A custom profile's `base_profile_id` must be a preset (`isValidCustomBaseProfileId()`); the base supplies only `access.rich_output` and the model fallback.
- A custom Agent is one current-configuration row (`run_profiles`) whose `version` increments on each edit; references are `custom:<id>@<version>` and any pin ≤ version resolves to the current configuration.
- Sessions and automations pin the version on creation (`pinProfileIdForUser()`, `access.ts`); `assertPinnedProfileExecutionAccess()` rechecks owner/super or team sharing at execution.
- `resolveProfileAsync()` throws for a missing custom Agent or version; it never falls back to Sprouty.
- The model is a per-turn choice: `POST /api/chat` `model` passes `isChatModelAllowed()` against `chat.selectable` and becomes `modelOverride`; anything else falls back to the profile's `model.id` without an error.
- A custom Agent's `model_id` that is no longer reachable falls back to its base preset's model; `GET /api/profiles` returns `models: listChatModels()`, which omits models without a reachable provider.
- Sampling options (`temperature`, `thinking`, `max_tokens`, …) belong to `options` in `config/models.yaml` (merged by `resolveModelConfig()`, explicit profile values win); profile YAML declares none.
- There is no `extends`; reuse prompt text by editing `sprouty.yaml`.
- `access` holds only `level: internal | hidden` and `rich_output`; session requirements belong to each runtime or route, not to a parallel permission layer in the profile.
- The rich-output block guide exists once, `RICH_OUTPUT_GUIDE` (`packages/utils/src/prompts.ts`), appended by `enrichSystemPrompt()`; never restate it in YAML.
- Prompts never restate rules of dynamically assembled tools (those live in each tool's `description`); an internal prompt may name only `is_global: true` tools or tools the profile's `tools:` declares.
- `name`/`description` may be a string or `{ zh, en }` (source locale `zh`); an unknown locale key or empty string fails profile loading; `system_prompt` is never localized.
- Stored profile ids are canonical (`sprouty`, `desktop`, `custom:<id>@<n>`); write `DEFAULT_PROFILE_ID`, never `team`.
- `normalizeProfileId()` maps retired ids (retired presets, team and eval ids → `sprouty`; `local-dev`/`local-pi` → `desktop`) at request edges only: `pinProfileIdForUser()` and the custom-Agent base; readers take a stored id as it is.
- Retiring another id means adding it to `normalizeProfileId()` and rewriting stored rows in a core migration; never recreate YAML for it.
- External agents (MCP clients, CLIs) reach cloud capabilities through `/api/agent/*` or `/api/mcp`, never a dedicated profile.

## Keep in sync after a profile change

- `agent-profiles.md` (architecture and tool matrix) and the constants in `profile.ts` (array order is the picker order).
- The universal client hard-codes `sprouty`: new-Agent base (`apps/client/src/automations/agents.ts`), automation default (`automations/editor.web.tsx`) and Sprouty ids (`data/home.ts`).
- `tests/api/agent-profiles.test.ts` pins the YAML count and names, legacy mapping, valid custom bases, the single rich-output copy, no `extends`, and keyless models staying out of the picker.
