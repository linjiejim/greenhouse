# Engine rules

The one engine for conversations and runs. Read with the root AGENTS.md and docs/product/data-model.md §4.

## Single writer
- A conversation has at most one active turn: a `runs` row with kind `turn` and status queued or running (unique index `runs_one_active_turn_key`).
- A message, a decision or a finished run that arrives while a turn answers goes to `conversation_inbox`. The next turn answers everything queued from the same person to the same Agent at once.
- Ending a turn and taking the next inbox item happen in one transaction under the conversation row lock (`for('update')`). Posting a message takes the same lock before it checks for an active turn. Keep both, or a message can be left with no turn to answer it.
- In one process, `withConversation` (locks.ts) queues writes per conversation. Across processes the row lock does it. The test transaction cannot model two connections; races between processes are tested in `*.db-commit.test.ts`.
- Every turn holds a lease (60 s, renewed every 10 s). API sweeps claim expired turns under the conversation lock: resume within ten minutes only when the active asker remains and the last model/tool step completed; otherwise interrupt and keep the text. Recheck the lease under the lock before touching steps or the reply. API sweeps also take orphaned inbox work, at boot and every 15 s.
- A draining process starts no new turn or job: inbox work waits for another API. SIGTERM drains for 60 s, then aborts model calls and expires owned leases; shutdown never counts as member cancellation. Worker processes never claim turns; API processes never claim background runs or jobs.
- Stop sets `desired_state = cancel`; the process running the turn aborts at once or at its next heartbeat. Stop drops what the stopping member queued.

## Turns
- The model comes from services.providers.languageModel (pinned key, metering, fallback). Never build a client here.
- A turn acts with the rights of the member who asked (`runs.owner_id`); a personal key serves only that member's own Agents.
- The reply row exists from the first token (status `streaming`) and its text is flushed every second, so a reload or a crash keeps what was written.
- A turn looks up who sees the conversation once (`conversations.audienceOf`) and again only after its people change (an empty `conversation.updated`, seen from any process through `hub.observe`). Its text deltas go out as one frame every 75 ms (at most 1000 characters), flushed before any other event about the reply; each frame keeps its offset.
- The hub splits long recipient lists across NOTIFY payloads. An event too big for one reaches other processes as a hint: a long final reply as `conversation.resync` (their clients catch up with `?after=`), a `records.changed` naming too many records with an empty list (many changed); any other stays local. NOTIFYs leave on one connection, in order.
- Every event for a conversation's people goes through the conversations service (`publish`, or a turn's `audienceOf`), which gives each person only the doc sources they may read; never send message events to `hub.publish` directly.
- After it exists, a reply is only written by UPDATE on its id, so a reply that was removed never comes back.
- A turn runs only while the member who asked is in the conversation. Leaving or being removed (`release`) stops their reply, drops their queue and expires their cards there.
- Prompt layout: fixed tool descriptions; rules (every rich block documented), identity, about, digest in the system prompt; the transcript; one closing message rebuilt each turn (`<turn_context>`: roster, memory index, the tools' `turnContext` lists, the rich blocks this screen draws; then the task). Anything written by models, pages or other people is fenced data (security/prompt.ts), never instructions.
- Between two turns without a summary fold the tool definitions and the system prompt are byte for byte the same: what changes per turn (connections, equipped skills, the screen's rich blocks, memories) goes in the closing message only.
- The tools offered depend on the Agent version and the member's access (modules, configured services, connectors an admin enabled, a second Agent for handoff), never on per-turn data; their order is the registry's.
- Cache breakpoints are neutral marks (`CACHE_BREAKPOINT` from @greenhouse/providers): the system prompt, the end of the transcript the next turn keeps, and the newest message of each call (history.ts `cacheBreakpoints` moves it, never adds up). Only adapters translate them (Anthropic `cacheControl`); OpenAI-compatible services and DeepSeek cache a stable prefix themselves.
- In development, a later turn of a conversation that read nothing from the cache logs a warning: the prefix moved.
- Rule paragraphs describe a tool only when the tool exists this turn.

## Edit and regenerate
- Only the member's own latest exchange changes, and only while no turn answers (`conversation_busy`). Everything after the edited message, or from the regenerated reply on, must be their turns' replies or their Agents' event lines (`not_latest` otherwise).
- Removed messages are deleted and announced as `message.deleted`; their sequence numbers are never reused. Their turns' cards expire: steps skipped, waiting runs canceled, nobody woken.
- The message is answered again through `dispatch`, the path a new message takes. A regenerated turn that a note woke (a decision, a hand-off) gets the same note through the inbox.
- A turn whose reply was removed while it streamed leaves receipts and hand-offs to the turn that answers again.
- The summary never folds the last two exchanges, so an edit never makes it stale; a summarised message refuses (`message_summarized`).

## Tools
- One file per tool with `defineTool` (tools/define.ts): description, zod input, risk, availability, and the service call. Routes and tools call the same services.
- Provider and MCP inputs go through tools/schema.ts: root object only, no root union combinators. Object unions merge their fields and action enums for providers; the original Zod schema validates and applies defaults before risk checks, cards or execution. The browser-test model enforces the same root rules.
- Tool results are evidence of actions; replies cannot perform a hand-off or another write. Screenshots are saved as reply attachments regardless of vision; only the model image context requires vision.
- Every call is a `run_steps` row. Tools that read outside text set `taints`; after that a turn cannot change memories.
- What a web page or a connector returns reaches the model through `outsideText` (security/prompt.ts): cut to size with a note of what was left out, stripped of anything that could pose as prompt structure; titles and snippets are sanitized too.
- A tool is `idempotent` only when the same call twice does what it does once (pure reads: web, knowledge and skill reads, conversation search, attachments). Computer, browser, vault, memory and every write are not.
- In a background retry a call with the same tool and arguments is the same step: a succeeded one returns its recorded output; a non-idempotent one an earlier attempt left running becomes `uncertain`, is not made, and the model is told to check first (calling it again in that attempt makes it).
- Steps a dead process left running are marked by the sweeps: reads failed (`interrupted`), anything else `uncertain`.
- Writes need manifest.write. callRisk is read / tier1 / tier2 / tier3: private reversible writes and untainted standing scopes run with receipts; shared writes otherwise wait; tier3 always waits and cannot grant a scope. Batch writes in one model step share a card that is ready only at step end.
- Descriptions are fixed text. A list that depends on the member and the turn (the connectors they can use, the Agent's skills) comes from `turnContext` and goes in the closing message, fenced. A risk that depends on the arguments comes from `callRisk`: risk and scope are checked again under their locks before executing, and the engine marks the approved run `ctx.approved`.

## Needs you
- Writes requiring approval never run when the model calls them: the call raises an approval card (`requests`, subject `tool_write`) holding the exact arguments, the step waits as `pending`, and the turn ends with the run `waiting`.
- A decision is a compare-and-set from pending (requests service). The engine then runs exactly the approved arguments with the asker's rights, or skips the step, writes one event line in the transcript, closes the waiting run, and wakes the Agent through the inbox with the outcome.
- Settling and expiring write a `request_decided` job in the same transaction; any process's decision worker carries it out (the settling process is woken after commit, every process polls, dead claims are taken over), up to 10 at once, each on its own. An approved call is told to stop after 5 minutes.
- An approval runs once: its step moves pending → running by compare-and-set and only the winner executes. A step found running (its process died mid-call) becomes `uncertain` and is never run again; the Agent is told to check. An approved proposal is applied once: the job records `applying`, then the outcome. Answers, hand-backs, rejections and expiries change nothing but what the Agent is told, and are simply worked out again.
- The follow-up (the event line, closing the run, the wake-up) is one transaction under the conversation lock and happens once: the line, keyed by `request_id`, records it.
- A tool that raises its own card (ask_user, self, request_takeover, vault) implements `decide`; return a null note to leave the Agent asleep.
- Expired cards are swept: the step is skipped, the run closes, and the Agent is not woken.
- Every card is a notification through `notifications.publish`, the one entry point for notifications; it also queues the card's email and push deliveries (modules/channels), which go out without what the card asks.

## Background runs
- A background run starts only from a member's decision: an approved `run_start` proposal or a schedule they set up. The model can propose, never start.
- Context is the approved brief plus the Agent's identity and instructions; history, memories and "about me" are not injected; explicit reads use the tools.
- Tools: memory recall, the source conversation only, connector reads, and tiered knowledge/table/mail writes. A pending card waits; its decision resumes the recorded model steps with actual tool results. Computer use requires a declared brief and domains; Docker stays offline, E2B restricts egress, private reads seal it offline. Computer work is exclusive and its processes are cleared before normal network access returns. Once a tool marked `private` ran, tools marked `outbound` refuse: nobody is watching, and a URL or a query can carry data out.
- Claiming checks the operational pause under a shared workspace row lock in the claim transaction; switching it waits for admitted claims. Active runs finish, queued runs wait.
- Claiming uses FOR UPDATE SKIP LOCKED; at most 3 running per member and 4 per process; 20 minutes and 30 steps per attempt.
- A run is created queued in the transaction of what causes it (`background.create`) and kicked after the commit; any process takes it from the queue. A schedule's firing claims the schedule, moves it to its next time after now and queues the run in one transaction, so firings missed while no process ran collapse into one run.
- A run whose process died is requeued up to 3 attempts; a shutdown requeues without counting as a failure.
- Every model step, as it ends, records what it added (the model's message, then the tool results) as a `run_steps` row of kind `model` (steps.ts, about 20k characters, long results cut first). Turns atomically record their step, reply id and completed text length too; recovery reuses that message and discards only the unfinished suffix; the run detail never lists them.
- A retry continues from the recorded steps after the brief, never from scratch; a call with the same tool and arguments as a succeeded step returns the recorded output. A run whose last recorded step was its answer ends with it.
- The timeline (`run_events`) is numbered per run and written in order. The end of a run is reported into its conversation (or the Agent's own thread) and notified.

## Rolling summary
- When a conversation goes idle and the text after its summary passes a quarter of the answering model's context window (24k estimated tokens when unknown), digest.ts folds older messages into `conversations.digest` (structured JSON, rendered within 1500 characters into the system prompt) and moves `digest_upto_seq`. History windowing (half the window) is only the last resort of a conversation that never idles; it logs when it drops messages.
- Cuts fall just before a member message and keep at least the last two exchanges, and as much more as fits in a third of the trigger; one call folds at most 30k tokens, oldest first. The write is a compare-and-set on the old boundary; failures back off.

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
- `mcp_call` (tools/connectors.ts) is the one tool for connectors: `list`, `describe`, `call`. It is offered when an enabled connector in the manifest's `connectors` (null: all) has a tool the Agent may call (or none listed yet), connected or not. The closing message lists only what this Agent may use for the asker: connected by the asker when the connector works with each member's account, and only the read-only tools when the manifest may not write.
- A tool declared read-only, or vouched read-only by an admin and not destructive, runs at once. Any other call is classed `external`: it raises the `tool_write` card with the exact arguments and runs only as the approved call, with the asker's key or sign-in, everything checked again then.
- Only in turns, never in someone else's public Agent: its owner's instructions could read the asker's accounts and send them elsewhere.
- What a connector returns is outside text: the tool `taints` and is `outbound`; results are cut to 20 000 characters, stripped of prompt structure, and keys and tokens are taken out.
- Servers are reached only through modules/connectors (network.ts): https, public addresses in production, a deadline on every request.
- Built-in connectors have no `connectors` row: the member's own mailbox (`mailbox`, modules/connectors/mailbox.ts) is listed in the closing message once they connected it, and `mcp_call` is offered wherever the manifest allows it, connected or not; its search and read tools are read-only, drafting and sending raise the card like any write.

## Skills
- A message's `skill` (a `/` run) is checked when it is sent (`skills.prepareRun`): a skill the sender sees, clean and not archived, whose requirements (computer, connectors) every answering Agent meets, with its required fields filled. The message records the version that runs.
- history.ts puts the sender's own run inside their message as `<skill_run>`: the template's filled text, or SKILL.md and the package's file list, fenced as the member's request. Someone else's run is only named; one blocked or archived since is named with why and its text leaves later turns. Typed text cannot pose as a block.
- `skill_query` lists the Agent's equipped skills (manifest `skills`) in the closing message, with why one cannot run; `load` and `read_file` read the asker's library with the asker's rights; `install` copies a package to `~/skills/<name>/` on the computer, in turns only.
- `skill_mutation` only proposes a template (card subject `skill_save`); accepting it saves the skill as the member. Equipping goes through the same requirement check (`skill_unavailable`).

## Budgets
- Every metered call (each model attempt too) is checked first against the enabled workspace, provider, member and Agent budgets that cover it (providers/budgets.ts); one used up refuses it with `budget_exceeded`, which a turn keeps as its error code and says in its reply. An instance over its own budget falls back to the next instance.

## Knowledge
- `knowledge_query` (search, read, list) and `knowledge_mutation` (create, edit, move, comment) call modules/knowledge with the asker's rights. Public Agents may read only their live publication grant; they never mutate knowledge.
- Reading is private and taints the turn: docs are other people's text. A doc read is a source under the reply (`kind: doc`, `#/knowledge/<id>`); a search hit only when the reply links it.
- Each person sees a `kind: doc` source only while they may read the doc: the conversations service filters sources per reader when it lists and publishes messages (knowledge `readableDocs`).
- In a room the knowledge tools' step lines and card summaries (which the decision line repeats) name no doc or folder; the card's details, which only the asker sees, and `run_steps` keep them.
- Writes raise the `tool_write` card, except inside the Agent's own private reference folder (`callRisk` answers read there). A doc the member cannot see is refused before any card.
- An edit sends the version it read; a newer one refuses it. Versions and comments record the Agent next to the member (`agent_id`); a member's own later edit of such a comment makes it theirs.
- The service caps a doc at DOC_CONTENT_MAX whoever writes it; an edit that would pass it is refused before any card. Every pattern run over doc text stays linear (markdown.ts), exports read docs a batch at a time inside the ZIP producer, and uploads are capped by `bodyLimit` with their text read under `fileText` limits.
- The private folder (`folders.agent_id`) is made on the first write, at the top of the owner's space; the owner's other Agents never see it and it is never shared. As a backstop, share reach, listings and search ignore any share inside one.
- Tree lists (a folder's contents, space roots, shared roots, the archive) are ordered and paged in SQL (`treePage`: hand order, folders first, then name as the database collates it, then id), never sorted in memory; `knowledge_query` list reads the first page.
- The tree lock (an advisory lock in service.ts): folder, doc and file moves hold it alone; creating, uploading and sharing hold it shared and read the place again under it. Folders nest at most 32 deep; tree walks fail on a loop or anything deeper instead of stopping short.
- File links in docs and comments are stored unsigned and signed per reader on read (modules/knowledge/markdown.ts): only with no origin or PUBLIC_URL's, and only as the whole target of a Markdown link or image that nothing around can extend. Another host's path, raw HTML, autolinks and bare addresses stay unsigned; a doc with `<base>` gets no signature.
- Doc Markdown reaches a page only through the editor's ProseMirror parser or a sanitiser: md-html's HTML is raw.
- Presence ("who has it open", KNOW-06) lives in each API process's memory, so with several processes people see only those on the same one. A heartbeat that fails its access check takes the member off the list at once; leaving tells only those still there, and only when the leaver was there.

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
- The Agent never types into a password or card field. Everything read from a page is redacted against the member's vault first, and no screenshot is taken while a page shows a vault value. A screenshot is stored as a conversation attachment and replaces the reply’s previous screenshot. A vision model also sees it with its next step (`ToolContext.attachImage`); a text-only model is told to use snapshot/read for decisions.
- `vault` is never offered to a public Agent, and a login serves only the Agents in its `agent_ids` (empty = all the member's own). The page origin always comes from the browser. The server types the values (`Input.insertText`), so none is ever in a tool result, a card, a step, the transcript or a log line.
- An `ask` login raises a `login` card first: approving fills on the site it named (even while the member holds the screen), rejecting tells the Agent, and handing back settles it after the member signed in by hand. `auto` logins and always-allowed sites fill directly. Every fill writes a `vault_access_log` row.

## Mail
- `mail` (tools/mail.ts) is the Agent's own mailbox (modules/mail): `list`, `search` and `read` read it; they taint the turn and a mail's text comes back fenced as untrusted input. Screened mail is never readable here.
- `send` and `reply` are external (tier 3, never pre-approved): `callRisk` answers tier3 only in the owner's own work, outside a room, for an Agent that may write; the card shows the recipients, the subject and the start of the body. The approved call sends from the Agent's address; a reply carries In-Reply-To and References. Anywhere else the tool refuses to send.
- Never offered to someone else's public Agent; a public Agent has no mailbox.
- Mail wakes an Agent through `deliver` with per-mail dedupe keys with a note of metadata only (the mail's id, the sender's address, a cut fenced subject). The wake layer merges it with other events.
- It wakes only for a sender the Agent may hear from (its owner, active members unless turned off, addresses let in) whose From domain passed DMARC, or SPF or DKIM aligned with it; at most 50 wakes a day. Anything else is screened; letting a sender in delivers what waited and wakes the Agent once.

- Memory remember/update are tier1 with undo; forget permanently deletes and is tier3. Background work may only recall; tainted turns never mutate memory.

## Always-on wakes and receipts
- Events, run reports and hand-backs use the inbox. Events collect for two minutes; member messages precede decisions, which precede events. Dedupe includes consumed rows. Three source-chain levels, 50 event turns per Agent per UTC day by default, one cap notification, suppressed events retained.
- Event turns and their decision follow-ups use background rules, taint from the start, and cannot treat event text as approval. A process-end event may inspect its computer offline, but cannot start new commands without a brief.
- A run's final state and run_report job commit together. Reporting, notification and optional follow-up are idempotent; quiet empty findings skip both the completion notification and follow-up. Failures notify.
- Undo metadata is separate from bounded display results. Lock the target and compare versions/revisions; never overwrite a later member edit. The member and service permissions are checked again when carrying out a card.

## M2.4
- Public knowledge reads use the live publication subtree in knowledge/access.ts; they never become member shares. Source filtering rechecks the grant.
- Helpers are background runs of the main Agent, at most three per turn, with a clean brief, read-only calls, eight steps and budget reservations. Claim only after the parent waits; summaries return through run_report with one batch dedupe key and taint the parent continuation. That continuation cannot delegate another batch; only a new member turn resets the limit.
- New tool results over 8,000 characters become owner-only tool_output files, with 30-day expiry and ranged reads. Never rewrite old transcript results.
- Completion logs are system-written memory data, never model instructions. Only seven days of log titles enter the index; recalling log detail taints the turn.
- Eval snapshots use the production prompt recipe and canonical tool hashes. Export strips credentials; fixtures use synthetic real-model acceptance conversations.
- The daily engine_retention job prunes terminal model context after 90 days and expired output bytes; edit/regenerate remove their old model context immediately.

## Table and app work
- Table citations are permission-filtered per recipient. Table reads use the same records and aggregate compiler; app reads/actions use immutable publications and intersected roles.
- Record handoffs and automation output use table_mutation, including result revision checks and approval cards. Inline record/event context starts tainted and private.
- Result writebacks use the same output-file wrapper as model calls; undo state keeps the full result.
- Table automation events use deliver, then create background runs under the wake cap. Their tools default to none; same_base_read is table_query confined to the source base. Carry tableEventChain through normal and approved writes.

- Page conversations resolve their saved object reference with the asker’s current rights on each turn. Page data is fenced in the closing message and taints the turn from the start.

- At a model step boundary, consume only this turn’s asker/Agent inbox entries under the conversation lock and live lease. End the previous reply, keep member seq, and append a continuation in the same run. Others queue; Stop wins under the same lock. Keep the existing total step cap across continuations and resumed attempts. Wait for the durable model boundary before consuming input; consumption, the injected model step and the new reply checkpoint commit together. During drain, new messages remain queued for another API.
- After incorporating new input, skip DeepSeek's old-context final-answer recovery. Eval capability snapshots use the provider registry, including image and video.
- generate_image uses the image provider and attaches artifacts. generate_video requires approval, then queues media_video jobs; media runs never enter the model worker. Completion uses the existing run_report job.

- The asker may interject without repeating @ in a room, including while a decision follow-up answers. Other named Agents queue. Freeze the initial history before the reply seq; later messages enter only at boundaries.

## Release runtime
- Digests are conversation_digest jobs, queued after an idle reply; only workers consume them.
- Turn recovery sends a small message.resumed frame before the full reply/update or deltas, so cross-replica clients discard unfinished live text even when the prefix needs resync. It preserves taint, tool evidence and completed text. A tool started after the last
  recorded model boundary makes a turn ineligible, even when its effect might have succeeded.
- Background shutdown requeues without spending a crash retry. Expired processes spend one.
- Nightly Eval uses the same synthetic fixtures with real provider resolution and bounded calls;
  service outputs are fixture data and shared writes must still stop at approval.
- Table automation wakes carry their action index into background run input. Creating the run and linking its automation history stay in the same inbox transaction.

- Request creation projects headings, summaries and details to permission-checked object names (modules/requests/display.ts). Never alter execution inputs or standing scopes. Room headings stay generic; app field labels use the publication/card column projection.

- Approval details are human label/value copy; Markdown previews declare format and select labels declare chips. Never serialize plans as card copy or show tool ids as step labels. Keep pending steps linked internally to their approval step and refresh their summaries after decisions.
- Reversible writes serialize on the conversation before scope locks. Same-run/table receipts carry step_ids and undo atomically in reverse order; revision lineage permits only changes within that batch, never newer member edits. Keep room summaries and receipts free of private names.
