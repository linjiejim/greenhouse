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
