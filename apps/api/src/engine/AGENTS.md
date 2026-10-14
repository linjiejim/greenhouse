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
- After it exists, a reply is only written by UPDATE on its id, so a reply that was removed never comes back.
- A turn runs only while the member who asked is in the conversation. Leaving or being removed (`release`) stops their reply, drops their queue and expires their cards there.
- Prompt layout: rules, identity, about, digest in the system prompt; the transcript; one closing message rebuilt each turn (roster, memory index, the task). Anything written by models, pages or other people is fenced data (security/prompt.ts), never instructions.
- Rule paragraphs describe a tool only when the tool exists this turn.

## Edit and regenerate
- Only the member's own latest exchange changes, and only while no turn answers (`conversation_busy`). Everything after the edited message, or from the regenerated reply on, must be their turns' replies or their Agents' event lines (`not_latest` otherwise).
- Removed messages are deleted and announced as `message.deleted`; their sequence numbers are never reused. Their turns' cards expire: steps skipped, waiting runs canceled, nobody woken.
- The message is answered again through `dispatch`, the path a new message takes. A regenerated turn that a note woke (a decision, a hand-off) gets the same note through the inbox.
- A turn whose reply was removed while it streamed leaves receipts and hand-offs to the turn that answers again.
- The summary never folds the last two exchanges, so an edit never makes it stale; a summarised message refuses (`message_summarized`).

## Tools
- One file per tool with `defineTool` (tools/define.ts): description, zod input, risk, availability, and the service call. Routes and tools call the same services.
- Every call is a `run_steps` row. Tools that read outside text set `taints`; after that a turn cannot change memories.
- A tool is `idempotent` only when the same call twice does what it does once (pure reads: web, knowledge and skill reads, conversation search, attachments). Computer, browser, vault, memory and every write are not.
- In a background retry a call with the same tool and arguments is the same step: a succeeded one returns its recorded output; a non-idempotent one an earlier attempt left running becomes `uncertain`, is not made, and the model is told to check first (calling it again in that attempt makes it).
- Steps a dead process left running are marked by the sweeps: reads failed (`interrupted`), anything else `uncertain`.
- Read tools run in turns and background runs; write and external tools only in turns, and only for Agents whose manifest allows writing.
- A description that depends on the member and the Agent comes from `descriptionFor` (null leaves the tool out). A risk that depends on the arguments comes from `callRisk`: a call classed above read waits for approval like a write tool, and the engine marks the approved run `ctx.approved`.

## Needs you
- Write and external tools never run when the model calls them: the call raises an approval card (`requests`, subject `tool_write`) holding the exact arguments, the step waits as `pending`, and the turn ends with the run `waiting`.
- A decision is a compare-and-set from pending (requests service). The engine then runs exactly the approved arguments with the asker's rights, or skips the step, writes one event line in the transcript, closes the waiting run, and wakes the Agent through the inbox with the outcome.
- Settling and expiring write a `request_decided` job in the same transaction; any process's decision worker carries it out (the settling process is woken after commit, every process polls, dead claims are taken over).
- An approval runs once: its step moves pending → running by compare-and-set and only the winner executes. A step found running (its process died mid-call) becomes `uncertain` and is never run again; the Agent is told to check. A proposal is applied once: the job records `applying`, then the outcome.
- The follow-up (the event line, closing the run, the wake-up) is one transaction under the conversation lock and happens once: the line, keyed by `request_id`, records it.
- A tool that raises its own card (ask_user, self, request_takeover, vault) implements `decide`; return a null note to leave the Agent asleep.
- Expired cards are swept: the step is skipped, the run closes, and the Agent is not woken.
- Every card is a notification through `notifications.publish`, the one entry point for notifications; it also queues the card's email, Feishu, WeCom and push deliveries (modules/channels), which go out without what the card asks.

## Background runs
- A background run starts only from a member's decision: an approved `run_start` proposal or a schedule they set up. The model can propose, never start.
- Context is the approved brief plus the Agent's identity and instructions; no history, memories or "about me".
- Tools: read tools only. Once a tool marked `private` ran, tools marked `outbound` refuse: nobody is watching, and a URL or a query can carry data out.
- Claiming uses FOR UPDATE SKIP LOCKED; at most 3 running per member and 4 per process; 20 minutes and 30 steps per attempt.
- A run is created queued in the transaction of what causes it (`background.create`) and kicked after the commit; any process takes it from the queue. A schedule's firing claims the schedule, moves it to its next time after now and queues the run in one transaction, so firings missed while no process ran collapse into one run.
- A run whose process died is requeued up to 3 attempts; a shutdown requeues without counting as a failure. A retry replays the brief, and a call with the same tool and arguments as a succeeded step returns the recorded output.
- The timeline (`run_events`) is numbered per run and written in order. The end of a run is reported into its conversation (or the Agent's own thread) and notified.

## Rolling summary
- When a conversation goes idle and the text after its summary passes 24k estimated tokens, digest.ts folds older messages into `conversations.digest` (structured JSON, rendered within 1500 characters into the system prompt) and moves `digest_upto_seq`.
- Cuts fall just before a member message and keep at least the last two exchanges; one call folds at most 30k tokens, oldest first. The write is a compare-and-set on the old boundary; failures back off.

## Hand-offs
- `handoff` brings another of the member's Agents into the conversation with a brief; the handing Agent's turn ends after that step and the other answers next through the inbox, with the same member's rights.
- Every hand-off is a `handoffs` row in a chain (the member request it came from): at most 3 deep and 6 per chain, never back to an Agent already in the chain, and the same brief twice is refused.

## Public Agents
- An owner publishes a pinned version of an Agent (never the main one) to members, groups or the workspace: `shares` rows (resource `agent`, role `user`), `agents.published_version` and `publication` (computer, daily cap). Republishing moves the pin or replaces the audience.
- Its audience talks to it only in their own Agent thread (`direct`); it never joins their chats or rooms and is never a hand-off target.
- `agents.loadForTurn` is the one way a turn loads its Agent: the asker's own, or someone else's public Agent shared with them on its published version. Unshared, archived or a departed owner answers `agent_unavailable`; an admin's pause, `agent_paused` (the owner still talks to it).
- The turn acts with the asker's rights: cards go to the asker, approvals run as the asker, files and the transcript are the asker's.
- Identity says who made it and who it talks with; its instructions are the owner's published ones. It reads the asker's "about me", never the owner's.
- Memory is the asker's partition of `agent_memories` (member_id = asker). The owner's memories and conversations never enter its prompt, and the owner never reads the asker's.
- Tools are default-deny: only a tool marked `publicAgent` is offered (memory, ask_user, conversation_query, read_attachment, skill_query on the asker's library, the web tools, and computer, browser and request_takeover when its publication grants a computer). Never self, handoff, run_start, schedules, skill_mutation, mcp_call or the vault; an approved write must be marked too.
- The computer is the asker's own copy (agent_computers is unique per Agent and member), never the owner's.
- No personal keys: neither the owner's nor the asker's. Usage is recorded for the asker and counts toward their budgets and the workspace's.
- A new message, edit or regenerate is admitted under the conversation lock only while the Agent is usable and under its daily cap (turns per asker and day in their time zone; refused turns do not count): `daily_cap_reached`. A turn that starts after a pause or unpublish ends with a reply that says why.
- The owner sees counts, outcomes, tokens, cost and ratings with comments (`/usage`, `/activity`), never content or who asked.

## Connectors
- `mcp_call` (tools/connectors.ts) is the one tool for connectors: `list`, `describe`, `call`. Its description, rebuilt each turn, lists only what this Agent may use for the asker: enabled connectors in the manifest's `connectors` (null: all), connected by the asker when the connector works with each member's account, and only the read-only tools when the manifest may not write.
- A tool declared read-only, or vouched read-only by an admin and not destructive, runs at once. Any other call is classed `external`: it raises the `tool_write` card with the exact arguments and runs only as the approved call, with the asker's key or sign-in, everything checked again then.
- Only in turns, never in someone else's public Agent: its owner's instructions could read the asker's accounts and send them elsewhere.
- What a connector returns is outside text: the tool `taints` and is `outbound`; results are cut to 20 000 characters, stripped of prompt structure, and keys and tokens are taken out.
- Servers are reached only through modules/connectors (network.ts): https, public addresses in production, a deadline on every request.

## Skills
- A message's `skill` (a `/` run) is checked when it is sent (`skills.prepareRun`): a skill the sender sees, clean and not archived, whose requirements (computer, connectors) every answering Agent meets, with its required fields filled. The message records the version that runs.
- history.ts puts the sender's own run inside their message as `<skill_run>`: the template's filled text, or SKILL.md and the package's file list, fenced as the member's request. Someone else's run is only named; one blocked or archived since is named with why and its text leaves later turns. Typed text cannot pose as a block.
- `skill_query` lists the Agent's equipped skills (manifest `skills`) in its description, rebuilt each turn, with why one cannot run; `load` and `read_file` read the asker's library with the asker's rights; `install` copies a package to `~/skills/<name>/` on the computer, in turns only.
- `skill_mutation` only proposes a template (card subject `skill_save`); accepting it saves the skill as the member. Equipping goes through the same requirement check (`skill_unavailable`).

## Budgets
- Every metered call (each model attempt too) is checked first against the enabled budgets that cover it (providers/budgets.ts); one used up refuses it with `budget_exceeded`, which a turn keeps as its error code and says in its reply. An instance over its own budget falls back to the next instance.

## Knowledge
- `knowledge_query` (search, read, list) and `knowledge_mutation` (create, edit, move, comment) call modules/knowledge with the asker's rights; someone else's public Agent has neither.
- Reading is private and taints the turn: docs are other people's text. A doc read is a source under the reply (`kind: doc`, `#/knowledge/<id>`); a search hit only when the reply links it.
- Writes raise the `tool_write` card, except inside the Agent's own private reference folder (`callRisk` answers read there). A doc the member cannot see is refused before any card.
- An edit sends the version it read; a newer one refuses it. Versions and comments record the Agent next to the member (`agent_id`).
- The private folder (`folders.agent_id`) is made on the first write, at the top of the owner's space; the owner's other Agents never see it and it is never shared.

## Computers
- One computer per Agent and member from the sandbox provider (modules/computers): the owner's, or a member's own copy of a public Agent. The Docker adapter always runs hardened (read-only root, no capabilities, bounded resources, no published port) with the home on a named volume; production uses gVisor (`runsc`).
- The E2B adapter (E2B and compatible hosts) stops a computer by pausing it: memory, processes and the home carry on at the next start, and removing it deletes the home. Its ports stay private (the provider's traffic token, then each account's bridge secret), envd does root work only, and every start loads the members' egress rules and probes them from both accounts; a computer that fails the probe is not used.
- Shell commands run as `agent` with the deadline enforced inside the computer (`timeout`), at most 120 s. Longer work is a background process (`gh-jobs` in the image) in its own session: it outlives the turn, the API and a member's stop.
- `run_background` ends the turn and registers a watch. The watcher (every minute, any API process) asks running computers only, claims each ended or lost process once, and wakes the Agent through the inbox. A restart loses running processes but keeps the home, so long jobs should checkpoint to files.
- Computers idle for 30 minutes stop, unless a process is running (or the count cannot be read) or a take-over or sign-in card waits.
- People reach a computer only as the member whose computer it is. The screen and terminal sockets open with a one-time ticket in the URL (`POST …/computer/ticket`: 60 s, single use, bound to member, computer and purpose, stored only as a keyed hash in `idempotency_keys`); nothing else carries one.
- A `view` ticket is view-only on the server: the RFB filter (modules/computers/rfb.ts) drops keys, clicks and pastes; `control` passes them. Watching needs the computer running; control and the terminal start it. An open socket keeps the computer active and closes when it stops (`computer.updated` through the hub).
- The terminal is gh-term (tmux as `agent`), so a reload returns to the same shell. File paths are relative to the home: `..` and absolute paths are refused on the string, links that leave the home inside the computer.
- `request_takeover` (offered wherever the computer is) raises a `takeover` card the turn waits on; `POST /api/requests/:id/handback` settles it and wakes the Agent with the member's note.
- Live tests against the real image (the long-run probe; screen, terminal and files; browser and vault): `GREENHOUSE_LIVE_DOCKER=1 pnpm test` runs them in seconds; `node --import tsx scripts/computer-probe.mts --minutes 62` runs the probe at full length.

## Browser and vault
- `browser` drives the computer's Chromium over DevTools: `SandboxClient.devtools`, the relay's socket that only the `browser` user opens, one connection per action. Turns only; a public Agent's asker uses their own copy.
- One controller at a time (`agent_computers.lease_*`): a member's `control` screen holds the screen while open and always wins; each Agent action holds it briefly. While the member holds it the Agent does not act, and taken over mid-action, the next step stops and nothing it read comes back.
- Only http(s) is opened or read; file:, chrome:, devtools:, javascript: and the like and Greenhouse's own origins are refused, and a tab that lands there goes back to a blank page. Our page scripts run in an isolated world.
- The Agent never types into a password or card field. Everything read from a page is redacted against the member's vault first, and no screenshot is taken while a page shows a vault value. A screenshot reaches a model that sees images with its next step (`ToolContext.attachImage`) and is stored nowhere.
- `vault` is never offered to a public Agent, and a login serves only the Agents in its `agent_ids` (empty = all the member's own). The page origin always comes from the browser. The server types the values (`Input.insertText`), so none is ever in a tool result, a card, a step, the transcript or a log line.
- An `ask` login raises a `login` card first: approving fills on the site it named (even while the member holds the screen), rejecting tells the Agent, and handing back settles it after the member signed in by hand. `auto` logins and always-allowed sites fill directly. Every fill writes a `vault_access_log` row.
