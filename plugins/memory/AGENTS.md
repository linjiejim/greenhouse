# Memory plugin

- Shared plugin rules: [root AGENTS.md](../../AGENTS.md) (Plugins) and [EXTENDING.md](../../EXTENDING.md); this file lists only Memory-specific rules.

## Writes and upkeep

- Memory is per member and injected into prompts; frictions (Feedback) are team-level and never injected; keep the two apart.
- Memories are written only through the `memory` tool (remember/recall/update/forget) and the member's own `/api/auth/me/memories`; there is no background extraction.
- The weekly `memory-consolidation` job merges duplicates, supersedes contradictions and demotes stale rows; it never invents memories and never merges or demotes pinned ones.
- The `memory` tool has no `surface` on purpose: it mixes reads and writes, so a proxy tier would let stateless callers write without a confirm gate; chat and automations reach it, `/api/agent` and `/api/mcp` do not.
- `memory` is `builtin` (joins every Agent's profile filter) but still rides the `memory` feature flag, so disabling the flag removes the tool.

## Recall and decay

- `resolveMemoryContext()` is the single prompt entry, registered as `promptContext` on the `memory` tool: it injects titles only within `MEMORY_INDEX_BUDGET_CHARS`; bodies come from `recall`; no vector store.
- The index is injected only when the `memory` tool is installed in the turn; never hand it to a call that cannot call the tool.
- Injection is not use: only recall/update refresh `last_used_at` (and wake dormant rows), or decay would treat every memory as used.
- Decay is a state machine, not a score: unused for `MEMORY_DORMANT_AFTER_DAYS` → `dormant` (out of the index, still searchable, recall reactivates); consolidation marks `superseded` with a pointer.
- The system never hard-deletes; the only hard delete is the member's own `DELETE /api/auth/me/memories/:id`.
- Memory failures return null and never break a turn.

## Access and safety

- Gate with `userHasFeature(…, 'memory')` (flag defaults on), never a raw `user_features` read: super and default-on members have no rows (`api/__tests__/memory-access.db.test.ts`).
- Memory text is model-written, user-editable and replayed every turn: `sanitizeForPrompt` before injection and `validateMemoryText` before every write (the tool and PATCH share it).
- Sensitive content (emails, phones, API keys, JWTs, long hex, `password=`-style pairs) is refused, not redacted, via kit `findSensitiveSpans()`; dates are excluded first and phones need 10–15 digits.
- Pinned memories never go dormant and sort first in the index.
- Refusals quote the offending excerpt so the model can fix it; contact-detail refusals add a hint to keep the person in a business record and the memory to the decision; credential refusals add nothing.
- Limits in `api/llm/memory-limits.ts` stay static constants: tool descriptions interpolate them while the catalog loads, so they must not depend on anything that imports the registry.
