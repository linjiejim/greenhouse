# Agent evaluations

This folder holds the **Agent scenario bank**: 43 end-to-end tasks in 10 domains (knowledge base,
tables, projects, automations, research, files, email, rich output, Bots, safety) that check the
whole agent — Chat, Bots and the mobile app — from three angles: the data it has, how it works,
and what it delivers.

| File | For |
|---|---|
| [agent-scenarios.md](agent-scenarios.md) | People (written in Chinese): environment setup, the rubric, every scenario, extra checks for runs on iOS |
| [agent-scenarios.yaml](agent-scenarios.yaml) | The same scenarios, machine-readable, for a future runner: `version`, `rubric`, and `scenarios[]` with `id`, `title`, `domain`, `difficulty`, `surfaces`, `prerequisites`, `data`, `process`, `deliverable`, `focus` |

Edit the two files together. Scenarios carry **no reference answers** by design: a reviewer scores
each run on process, deliverable and safety/boundaries, 0–2 each (6 max). Every fact a scenario
states about the demo data must match `data/examples/` and the scripts and fixtures that seed the
rest, and every tool capability it relies on must be real.

## Running it today (by hand)

1. Start a stack whose database holds the example dataset: `pnpm seed` (`--keep` when the database
   already has accounts). With `pnpm run-dev`, seed the database `node scripts/run-dev.mjs status`
   reports: `DATABASE_URL=<its url> pnpm seed --keep`.
2. Prepare what the scenario lists under **前置** — the Customer Feedback base
   (`E2E_BASE_URL=<web url> node scripts/capture-screens.mjs --only seed`), a Bots computer
   (`pnpm run-dev up --bots`) serving the Acme portal from `tests/fixtures/bots-demo-site/`, a test
   mailbox bound in Settings → Email Accounts, or attachments you bring yourself.
3. Sign in as the account the scenario names (the seeded users and the shared demo password are in
   [data/examples/README.md](../../data/examples/README.md)), run it on the stated surface and score
   it with the rubric. On iOS, also note the UX checks in the appendix.
4. Record date, commit, model, account and the three scores per scenario so runs can be compared.

## Why Administration → Evaluation can't run these

The built-in batch eval (`/api/eval`, `pnpm cli eval`; `apps/api/src/eval.ts` and
`apps/api/src/runtime/eval-driver.ts`) is a regression check for single answers:

- **Single-turn** — one question per case: no follow-up turns, no approval cards to press, no
  `ask_user` form to fill.
- **Safe-read tools only** — the page runs every case as one Chat turn for the super who started
  it, restricted to the unattended replay-safe reads: no writes, no web search, no image analysis,
  and never Bots, a Bots computer or the mobile app. Team-permission scenarios can't be expressed.
- **`ground_truth` arrays** — an LLM judge grades each answer against a JSON array of facts it must
  contain. The scenario bank has no such answers to compare against.

Its starter set (`pnpm cli eval seed`, or Seed on the Evaluation page) asks ten questions about the
example knowledge base and general knowledge — a smoke test for retrieval and refusals, not a
substitute for the scenarios.

## Next

A **scenario runner** is the planned follow-up: read `agent-scenarios.yaml`, prepare each
scenario's prerequisites, drive the conversation on its surface (card decisions and follow-up turns
included) and hand the transcript to a reviewer or an LLM judge that applies the rubric. Until it
exists, the bank is run by hand.
