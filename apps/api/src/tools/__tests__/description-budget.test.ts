/**
 * Tool-description budget gate ("工具税" 门禁).
 *
 * Every tool's `description` ships in FULL to the model on EVERY step of EVERY
 * chat turn — there is no progressive disclosure and no cache on our side, so
 * description text is a fixed per-request token tax on every internal user
 * (≈8k tokens across the catalog today, before zod `.describe()` parameter
 * docs, which roughly add another half on top).
 *
 * This pins the totals so growth is a conscious decision instead of drift.
 * If you trip it: first shorten (move methodology to skills/docs, cut
 * duplicated examples, collapse per-action prose), and only raise the budget
 * in the same PR with a written justification.
 */

import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS } from '../registry.js';

/**
 * Whole-catalog ceiling, in characters (chars keep the gate deterministic).
 *
 * 33_000 → 33_500 on 2026-08-03 for `tables_schema_plan`, the conversational
 * Tables schema editor. It first landed at 2_842 chars and was cut to ~1_180 by
 * deleting everything the parameter schema already ships — the 17 field types
 * (a zod enum), rollup aggregations and formula result types (both enums), the
 * ref/id exclusivity and select-option id rules (all `.describe()` text). What
 * remains cannot live anywhere else: the confirm-gate semantics, two runtime
 * behaviours the model would otherwise fight (creating a Base also creates a
 * table; every new table already owns a primary "Name" field), and the formula
 * AST shape, whose parameter is `z.unknown()` and therefore self-documents as
 * nothing. That residue is the +222 over the old ceiling; the rest of the raise
 * is deliberate headroom, not pre-approval — the next tool trips this again.
 *
 * 33_500 → 35_000 on 2026-08-03 for the Automation pair (`automation_query` +
 * `automation_mutation`), which let the agent create and manage scheduled tasks.
 * They first landed at 2_444 chars and were cut 32% to 1_671 by deleting what
 * the parameter schema already ships — the per-action argument lists, the cron
 * syntax and its 1-hour floor, the prompt/max_steps ranges, the timezone default
 * (all `.describe()` text). What remains cannot live anywhere else: the confirm
 * policy (restate the schedule in plain language before writing), the pause-vs-
 * delete distinction, that run_now hands back a session_id, and the one failure
 * mode the schema states but does not teach — each run is a FRESH conversation,
 * so the prompt must stand alone, which is worth its concrete counter-example.
 * The per-user quota stays because the model should pre-check it. That residue
 * is the +1_671; the ~100 chars left over are headroom, not pre-approval.
 *
 * 35_000 → 35_500 on 2026-08-03 for two Tables lessons that have nowhere else to
 * live. They first landed at 1_416 chars and were cut 64% to 505. What survives:
 * (1) a Base/table `description` is the team's usage note, so read it before
 * querying and ask instead of inferring when it is empty — the field is already
 * in every `tables_query` payload, and the model was reading past it and guessing
 * semantics from field names; (2) new Bases/tables must get one, and a plan that
 * changes what a table is FOR must refresh it in the same plan. Deleting a table
 * or Base stays a manual, on-screen act (spec D5) — that was already one clause
 * in the CANNOT list, so it only grew by the sidebar path the model needs to
 * hand the user. Cut on the way in: the empty-description offer to write one,
 * the worked example of what a good description contains, the `pnpm cli tables
 * restore-*` invocation (admin trivia the model never runs), and the recycle-bin
 * contrast for records. The ~100 chars left over are headroom, not pre-approval.
 *
 * 35_500 → 37_200 on 2026-08-04 for the memory pair (`memory` + `log_friction`).
 * (Raised against 35_000 on the branch; rebasing onto the Tables raise above made
 * the two increments additive, so the ceiling chains rather than replaces.)
 * They first landed at 3_234 chars and were cut 47% to 1_724 by deleting what
 * the parameter schema already ships — the per-action prose (the action enum
 * describes all four), the friction taxonomy (the kind enum defines all five),
 * the field limits and the recall mechanics (all `.describe()` text, some of it
 * folded back into the parameter that owns it). What remains cannot live
 * anywhere else, and both tools are default-on, so this is the most-paid-for
 * text in the catalog:
 *   • WHEN to write — "the user said remember" is mandatory, everything else is
 *     a judgement call, and the do-not-store list is what stops the model from
 *     turning every task detail into a permanent note;
 *   • the English-with-verbatim-literals rule (spec D11). It is one rule
 *     covering two fields in one tool and two in the other, so stating it once
 *     per tool is already the cheap encoding. Its counter-example (a translated
 *     `潜在` stops matching the column it names) is what makes it stick;
 *   • that a friction note is about the TOOLING, not the user — without it the
 *     model reasonably reads `log_friction` as tattling and declines to use it.
 * That residue is the +1_724; measured total is 37_118, so the ~82 chars left
 * over are headroom, not pre-approval. See docs/specs/20260804-memory-v2.md.
 *
 * 37_200 → 37_800 on 2026-08-04 for the records-app customer file cabinet
 * (`list_files` / `read_file` / `attach_file`) and PDF text extraction.
 * First attempt was a straight raise against the pre-leads baseline and did not
 * need one at all: cutting the filter/sort/optional-field lists that `records_manager`
 * duplicated from its own zod `.describe()` text paid for the whole feature.
 * Rebasing onto the lead-pool work removed that option — it had independently
 * made the same cuts, and left the catalog at 37_159 with 41 chars of headroom.
 * The remaining +543 was then trimmed to what three actions cannot be used
 * without:
 *   • that the cabinet IS the customer's Files tab, not a second store — the
 *     model otherwise offers to "upload somewhere" instead of using it;
 *   • which formats `read_file` returns text for, and that scans and encrypted
 *     PDFs come back as an explicit error. Without the second half a refusal
 *     reads like an empty document and gets summarised as one;
 *   • that `attach_file` is chat-only, because it needs the session that owns
 *     the attachment — on the proxy/MCP face it refuses itself.
 * Deleted on the way in: the parameter lists (all in `.describe()`), the
 * per-format breakdown repeated in all three records-app tools, and the "never a guess"
 * flourish. Measured total is 37_702, so the ~98 chars left over are headroom,
 * not pre-approval. Note that a query/mutation pair granted by one flag bills such a
 * sentence twice; consolidating is the cheaper option.
 *
 * 37_800 → 38_400 on 2026-08-04 for an ERP analytics tool that has since been
 * retired from this catalog. Its residue was three facts every answer had to
 * restate (data freshness, currency, profit caliber) that no parameter could
 * carry; the ceiling followed the measured total, not the other way round.
 *
 * 38_400 → 39_000 on 2026-08-05 for the workbench pair (`workbench_query` +
 * `workbench_mutation`), which let the agent build and edit the user's home
 * page. They first landed at 810 chars and were cut 35% to 528 by deleting what
 * the parameter schema already ships — the per-action breakdown (the action enum
 * describes all three reads), that removals need confirm (the `confirm` field
 * says which two actions require it), the date-token vocabulary and the dot-path
 * mapping rules (all `.describe()` text on the fields that own them). What
 * remains cannot live in a parameter:
 *   • the three names for one screen (home page / Home / 首页 / 工作台). Users ask
 *     for this by any of them, and an unmatched name means the model answers
 *     that it cannot edit the home page — which is the whole feature;
 *   • that a card stores a QUERY and not its answer. Without it the model
 *     "helpfully" pastes the numbers it just fetched into a note card, which is
 *     wrong the next morning and silently so;
 *   • that a write hands back a live preview and an empty one must be fixed, not
 *     announced as success. This is what pays for those writes being unconfirmed
 *     (spec D15) — the model verifying its own card is the safety story.
 * No cut elsewhere was available to pay for this: nothing in the catalog
 * duplicates it. Both tools are is_global (a workbench nobody can ask for is a
 * dead entry point in the Chat empty state), so this bills every internal user —
 * measured total is 38_949, and the ~51 chars left over are headroom, not
 * pre-approval. See docs/specs/20260805-home-workbench.md.
 *
 * 39_000 → 40_500 on 2026-08-05 for the email pair (`email_query` +
 * `email_mutation`), which bring mailbox reading and sending back after the
 * 0.18.0 removal. They first landed at 1_919 chars and were cut 28% to 1_388 by
 * deleting what the parameter schema already ships — the per-action argument
 * lists (the action enums describe all four reads and both writes), the folder
 * default, the reply-threading mechanics, and the attachment/session caveat (all
 * `.describe()` text on the fields that own them). What remains cannot live in a
 * parameter:
 *   • that `send` mails the STORED draft and ignores the fields passed to it.
 *     This is the security property of the whole tool, and a model that thinks
 *     it can amend a message at send time will confidently tell the user it did;
 *   • that a failed read is an error and not an empty inbox. Every previous
 *     version of this module returned `[]` for an unreachable mailbox, and
 *     "no messages" is the one wrong answer that looks exactly like a right one;
 *   • that message text is attacker-authored — the sanitizer strips the markers,
 *     but only this sentence stops the model from acting on a plainly-worded
 *     instruction inside a body it was asked to summarize;
 *   • that the shared mailbox cannot write outside @example.com, so the model
 *     picks a personal mailbox instead of drafting something that will be
 *     refused after the user already confirmed it.
 * No cut elsewhere was available: nothing in the catalog covers mail. Both tools
 * are feature-flagged (`email`, opt-in) rather than default-on, so this bills
 * only the users who have been granted a mailbox — measured total is 40_337, and
 * the ~163 chars left over are headroom, not pre-approval.
 * See docs/specs/20260805-email-revival.md.
 *
 * 40_500 → 38_400 on 2026-08-07 — a REDUCTION, from merging the admin tools.
 * `dashboard_query` (1_469) folded into the admin query tool (610 → 1_325), and
 * the admin mutation tool (591) plus the source-update tool (718) were deleted
 * outright, so the catalog lost three entries and 2_063 chars net; measured
 * total is 38_197. The freed budget is locked away rather than left as headroom:
 * a ceiling that no longer reflects the catalog is not a gate, it is a silent
 * pre-approval for the next 2k of drift. The merged tool grew by 715 over the
 * narrow tool it kept the name of, and every char of that is text neither
 * predecessor could drop: the resource list (a 17-value enum the model must
 * choose from, previously only in `dashboard_query`), and the one thing the
 * merge itself created — that resource=log and action=device_logs are two
 * different log backends, which is exactly the confusion a single tool with
 * both surfaces invites. See docs/specs/20260806-dashboard-readonly-query-port.md D4.
 *
 * 38_400 → 34_500 on 2026-08-07 — a second REDUCTION, from retiring the chat
 * monoliths. `records_manager` (3_909) and `project_manager` (191) were exactly
 * their query∪mutation pairs over the same dispatch, and `session_history`
 * (645) was a subset of `session_query` — three entries deleted, so a records-app chat
 * turn stops billing the same domain twice. The survivors absorbed only what
 * no parameter can carry: the lead-vs-customer gate moved into `records_mutation`
 * (the schema can say convert_lead exists, not that create_company from raw
 * info is wrong), the recall guidance ("上次我们讨论的…" → search then messages)
 * moved into `session_query`, and `project_query`/`project_mutation` gained one
 * action name each (summary's report shape, comment.add). Measured total is
 * 34_281; the ceiling follows it down for the same reason as last time.
 *
 * 2026-08-09: +850 for `task_capture`, a genuinely new capability rather than a
 * restatement of an existing one — there was no redundancy to trade against,
 * which is the usual way this ceiling gets paid for. It was written lean
 * (schema `.describe()` carries the per-field detail) and the ceiling moves to
 * the new measured total + the same ~200 of headroom as before. A tool that
 * only rephrases an existing one still does not get this treatment.
 *
 * 2026-08-14: 35_550 → 35_250 after `team_knowledge` / `personal_knowledge` were
 * retired into `knowledge_query`. The knowledge surface went from three
 * descriptions (2_346 chars) to one (1_812) even after absorbing the 产品-column
 * authority rules verbatim and gaining `tree`/`folder`/`mode` — the folder
 * layout listing paid for most of it, because `action=tree` returns the real
 * tree and a hardcoded copy of it could only drift. Measured total is 35_019;
 * the ceiling follows it down, as it did in the previous consolidation.
 *
 * 35_250 → 36_100 on 2026-08-17 for six invariants sunk while retiring the
 * first-party app skills (see spec 20260722 D12/D13; playbooks migrate to the
 * KB guide column at ship time). Skills are INSTALLED copies and the audit found
 * them already drifted (one listed 11 of ~30 actions of its tool); a tool description travels with the connection, so a
 * behavioural rule the model must always hold belongs here or nowhere:
 *   • admin data tools: timestamps are UTC, shift local-time ranges — the
 *     one caliber the tool cannot express in a parameter and the top source of
 *     off-by-a-day answers; plus the personal-data handling rule (work use
 *     only, never spread or persist to shared locations);
 *   • mirrored sources: errors in a mirror are fixed upstream (report the slug),
 *     never shadow-"corrected" into the team KB — placed at the discovery
 *     point only; all descriptions share one context window, so paying for a
 *     twin sentence in knowledge_mutation buys nothing;
 *   • project_mutation: completed vs archived semantics (deletion is absent by
 *     design) and record-the-conclusion-when-closing;
 *   • records_mutation: log a followup after every substantive contact, and
 *     records_query: rollups are system-computed, judge activity by the followups
 *     themselves — the team disciplines the schema cannot state.
 * That residue is the +920; measured total is 35_939, so the ~161 left over are
 * headroom, not pre-approval.
 */
const TOTAL_DESCRIPTION_BUDGET = 36_100;

/**
 * Per-tool ceiling. Current worst offender sits just under it (workflow_plan
 * ~3.5k) — new tools should stay far below.
 */
const PER_TOOL_DESCRIPTION_BUDGET = 4_000;

describe('tool description budget', () => {
  it('catalog-wide description total stays within budget', () => {
    const total = TOOL_DEFINITIONS.reduce((sum, meta) => sum + meta.description.length, 0);
    expect(total).toBeLessThanOrEqual(TOTAL_DESCRIPTION_BUDGET);
  });

  it('no single tool exceeds the per-tool budget', () => {
    const over = TOOL_DEFINITIONS.filter((meta) => meta.description.length > PER_TOOL_DESCRIPTION_BUDGET).map(
      (meta) => `${meta.id}=${meta.description.length}`,
    );
    expect(over).toEqual([]);
  });

  it('every tool has a non-empty description and brief', () => {
    for (const meta of TOOL_DEFINITIONS) {
      expect(meta.description.trim().length, meta.id).toBeGreaterThan(0);
      expect(meta.brief.trim().length, meta.id).toBeGreaterThan(0);
    }
  });
});
