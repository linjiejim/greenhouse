# Feedback plugin

- Shared plugin rules: [root AGENTS.md](../../AGENTS.md) (Plugins) and [EXTENDING.md](../../EXTENDING.md); this file lists only Feedback-specific rules.

## Frictions

- A friction is the agent stumbling (tool error, wrong parameter shape, detour, data quirk, capability gap); frictions are team-level, reviewed by people and never injected into any prompt.
- `api/frictions/friction-center.ts` is the single implementation behind both writers: the daily `friction-mining` job and the `log_friction` tool.
- Mining is pure SQL plus string normalization over `messages.parts -> 'pipeline'` (`mineToolErrors`) and empty retrieval results (`mineEmptySearches`, one row per tool); it costs no LLM call.
- `log_friction` covers detours that never errored; it is a `builtin` proxy write in MCP group `feedback`, recorded per member and client, and has no read action.
- Fingerprint = tool + kind + `normalizeErrorText(error)`: one row per problem, `occurrence_count` is the priority, and a recurrence reopens a resolved row; record in one statement because both writers race.
- Counts are deliberately approximate (the 25-hour window overlaps, restarts recount); they rank work, they are not a ledger.
- Evidence is redacted with kit `redactEvidence()`, never refused (unlike memories): the diagnostic value is in the original text.
- `normalizeErrorText` turns quoted values and numbers into placeholders, so tool error messages must quote every interpolated value (`"${id}"`) or one problem splits into many rows.
- Field limits live in `api/frictions/friction-limits.ts`, a zero-import leaf: the tool description interpolates them while the catalog loads.
- Never build shared, auto-injected "lessons" from frictions: one bad entry would reach every member; fixes belong in tool descriptions, implementations, prompts, skills or code.

## Review queue and requests

- `/api/admin/frictions` (super) is the triage queue: list by frequency, change status with a resolution note, delete false positives, and run mining on demand.
- `feature_request` is a proxy write (`submit`; super also `list`/`update`); `feedback_query` reads the caller's own requests and admin notes (super may read everyone's).
- The universal client screen is Admin › Issues & requests (`apps/client/src/plugins/feedback/admin.web.tsx`), with requests and frictions as two tabs.
- `POST /api/me/feedback` lets a member file an issue or request directly from a client (strict body, message ≤4000 chars).
