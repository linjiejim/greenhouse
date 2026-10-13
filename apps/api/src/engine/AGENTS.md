# Engine rules

The one engine for conversations and runs. Read with the root AGENTS.md and docs/product/data-model.md §4.

## Single writer
- A conversation has at most one active turn: a `runs` row with kind `turn` and status queued or running (unique index `runs_one_active_turn_key`).
- A message, a decision or a finished run that arrives while a turn answers goes to `conversation_inbox`. The next turn answers everything queued from the same person to the same Agent at once.
- Ending a turn and taking the next inbox item happen in one transaction under the conversation row lock (`for('update')`). Posting a message takes the same lock before it checks for an active turn. Keep both, or a message can be left with no turn to answer it.
- In one process, `withConversation` (locks.ts) queues writes per conversation. Across processes the row lock does it. The test transaction cannot model two connections; races between processes are tested in `*.db-commit.test.ts`.
- Every turn holds a lease (60 s, renewed every 10 s). `sweep()` ends turns whose lease expired as `interrupted`, keeps the text they wrote, and starts queues left without a turn. It runs at boot and every 15 s.
- Stop sets `desired_state = cancel`; the process running the turn aborts at once or at its next heartbeat. Stop drops what the stopping member queued.

## Turns
- The model comes from services.providers.languageModel (pinned key, metering, fallback). Never build a client here.
- A turn acts with the rights of the member who asked (`runs.owner_id`); a personal key serves only that member's own Agents.
- The reply row exists from the first token (status `streaming`) and its text is flushed every second, so a reload or a crash keeps what was written.
- Prompt layout: rules, identity, about, digest in the system prompt; the transcript; one closing message rebuilt each turn (roster, memory index, the task). Anything written by models, pages or other people is fenced data (security/prompt.ts), never instructions.
- Rule paragraphs describe a tool only when the tool exists this turn.

## Tools
- One file per tool with `defineTool` (tools/define.ts): description, zod input, risk, availability, and the service call. Routes and tools call the same services.
- Every call is a `run_steps` row. Tools that read outside text set `taints`; after that a turn cannot change memories.
- Read tools run in turns and background runs; write and external tools only in turns, and only for Agents whose manifest allows writing.

## Needs you
- Write and external tools never run when the model calls them: the call raises an approval card (`requests`, subject `tool_write`) holding the exact arguments, the step waits as `pending`, and the turn ends with the run `waiting`.
- A decision is a compare-and-set from pending (requests service). The engine then runs exactly the approved arguments with the asker's rights, or skips the step, writes one event line in the transcript, closes the waiting run, and wakes the Agent through the inbox with the outcome.
- A tool that raises its own card (ask_user, self) implements `decide`; return a null note to leave the Agent asleep.
- Expired cards are swept: the step is skipped, the run closes, and the Agent is not woken.
- Every card is a notification through `notifications.publish`, the one entry point for notifications.

## Background runs
- A background run starts only from a member's decision: an approved `run_start` proposal or a schedule they set up. The model can propose, never start.
- Context is the approved brief plus the Agent's identity and instructions; no history, memories or "about me".
- Tools: read tools only. Once a tool marked `private` ran, tools marked `outbound` refuse: nobody is watching, and a URL or a query can carry data out.
- Claiming uses FOR UPDATE SKIP LOCKED; at most 3 running per member and 4 per process; 20 minutes and 30 steps per attempt.
- A run whose process died is requeued up to 3 attempts; a shutdown requeues without counting as a failure. A retry replays the brief, and a call with the same tool and arguments as a succeeded step returns the recorded output.
- The timeline (`run_events`) is numbered per run and written in order. The end of a run is reported into its conversation (or the Agent's own thread) and notified.

## Rolling summary
- When a conversation goes idle and the text after its summary passes 24k estimated tokens, digest.ts folds older messages into `conversations.digest` (structured JSON, rendered within 1500 characters into the system prompt) and moves `digest_upto_seq`.
- Cuts fall just before a member message and keep at least the last two exchanges; one call folds at most 30k tokens, oldest first. The write is a compare-and-set on the old boundary; failures back off.

## Hand-offs
- `handoff` brings another of the member's Agents into the conversation with a brief; the handing Agent's turn ends after that step and the other answers next through the inbox, with the same member's rights.
- Every hand-off is a `handoffs` row in a chain (the member request it came from): at most 3 deep and 6 per chain, never back to an Agent already in the chain, and the same brief twice is refused.
