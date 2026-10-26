# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Configured workspace plugin packages, deterministic `plugins:sync` assembly, import boundaries and a zero-plugin core CI gate.
- Read-only Administration → Plugins and `cli plugins list/status/drop` with disabled-only, explicit table removal.

extension-kit: expose the existing snapshot-locked API and web kits as `@greenhouse/api/extension-kit` and `@greenhouse/web/extension-kit`; no symbol removals.

### Changed

- 知识库迁为默认启用的官方插件，接管文档、版本、分享、检索、编辑器、MCP 资源与经典网页；既有 API 和链接不变。
- 每月复盘迁为依赖 Knowledge、默认关闭的官方插件。核心团队上下文支持 Markdown；Knowledge 启用时继续提供团队文档选择。
- 24 张已迁移业务表的真实 3.0 升级测试验证行数与完整内容不变，覆盖 Knowledge 停用/重启用。

extension-kit: add shared FTS/schema/file/storage helpers, summary/timezone and replica-safe job facades, context selection types and classic editor/sidebar/settings primitives required by Knowledge and Retro. Remove the plugin-owned RetroButton re-export; use the feedback.actions slot or the Retro package page. Update the locked kit snapshots.

- Tables 成为默认启用的官方插件；表、字段、视图、公式、记录、附件、目录、工具、CLI 与经典网页由插件拥有。既有 API、MCP、功能开关与链接保持兼容，停用不删数据。
- 分享、文件关联、目录、审计应用、运行种类与卡片回执种类改为按启用插件注册值校验新写入；迁移保留历史记录。

extension-kit: expose existing artifact receipt/claim helpers, shared file/link/share schema targets and audit types, CLI flags, row-id validation, catalog input, and classic drive/catalog/artifact-card helpers required by Tables; no existing exports removed.

- Extract SkillHub (default on) and Projects (default off) into official plugins, with unchanged REST URLs, tool ids and MCP prompt names. Saved prompts remain core; plugin-disabled servers keep data and remove optional surfaces.
- Add permission-filtered agentContext fragments/resources/prompts, plugin object-reference and recent-activity sources, and contributed route rate limits.

extension-kit: add shared S3/path/semver helpers, saved-prompt facade/types, activity cursor and bounded-feed helpers, and classic forms/context/download components required by SkillHub/Projects; no existing exports removed.

- Extract Email, WeCom and Feishu into default-off official plugins, including personal/shared mailboxes, OAuth binding/login, the Feishu bot and optional notification delivery. Existing paths, ids, preferences and env names are preserved; disabled data stays intact.
- Add public identity-provider discovery and plugin registries for delivery adapters, notification kinds and agent channels. Notification writes validate active kinds/channels instead of DB CHECKs.

extension-kit: add identity policy/routes, channel runtime/turn execution, notification rendering/envelope helpers, mailbox crypto/egress/file helpers, DB foreign-key targets and authenticated classic client session helpers required by communication plugins; no pre-existing exports removed.

- Extract Memory, Feedback, Reports and Computer into official plugin packages, preserving URLs and tool ids. Adoption migrations preserve existing data.
- Automation grants and MCP working hints now follow the active plugin set; inactive modules are absent from both.
- Conversation sharing is controlled by `conversations.sharing` (default true); the design gallery is development-only.

extension-kit: add the DB schema primitives, metering/budget/provider hooks, workspace flags/bootstrap, file-cabinet helpers, redaction, activity types, and shared web form/CRUD/preview/formatting components required by the four plugins; no existing symbols removed.

### Upgrading from 3.x

Knowledge 默认保持启用；每月复盘现在默认关闭。若要保留全部 3.x 模块，配置 `extensions.enabled: ['knowledge', 'tables', 'skills', 'feedback', 'memory', 'projects', 'reports', 'email', 'wecom', 'feishu', 'computer', 'retro']`，或 `GREENHOUSE_EXTENSIONS=knowledge,tables,skills,feedback,memory,projects,reports,email,wecom,feishu,computer,retro` 后重启。停用不会删除文档、历史版本或任何插件数据。

Projects, Reports, Computer, Email, WeCom and Feishu are now off by default. To keep all six, set `GREENHOUSE_EXTENSIONS=knowledge,tables,skills,feedback,memory,projects,reports,computer,email,wecom,feishu`, or use `extensions: { enabled: ['knowledge', 'tables', 'skills', 'feedback', 'memory', 'projects', 'reports', 'computer', 'email', 'wecom', 'feishu'] }` in `greenhouse.config.ts`. Keep any deployment-specific plugins in that list. Computer also retains its independent credential and workspace-switch checks. Disabled tables and rows remain available when re-enabled.


- Move the example and its migrations, MCP/seam tests and browser spec into `plugins/example`; SDK 1 in-tree overlays remain supported.

## [3.0.2](https://github.com/linjiejim/greenhouse/compare/v3.0.1...v3.0.2) (2026-10-26)


### Fixed

* **agent:** stop steering replies toward rich blocks ([f178079](https://github.com/linjiejim/greenhouse/commit/f178079751b07cbe22bba8c43e9b764f62b10459))

## [3.0.1](https://github.com/linjiejim/greenhouse/compare/v3.0.0...v3.0.1) (2026-10-26)


### Fixed

* **auth:** a stored grant drops the groups of inactive extensions instead of failing ([5c7436b](https://github.com/linjiejim/greenhouse/commit/5c7436b35ab2bf4f347efd45eb709d18bfd22a60))

## [3.0.0](https://github.com/linjiejim/greenhouse/compare/v1.6.0...v3.0.0) (2026-10-26)

3.0 continues the 1.x team hub (the 2.x personal-assistant line is retired). A 1.6 database moves
to 3.0 with `pnpm cli migrate-from-1x`; 2.x databases are not supported.

### Added

* **db:** a rebuilt schema (one 3.0 baseline), `migrate-from-1x` to carry a 1.6 database with its ids, a reconcile report and a refusal of half-carried databases, daily retention cleanup of high-growth tables
* **home:** Home is the new conversation on web and phone; the team's recent changes live in the bell's Team activity tab
* **connectors:** MCP client connectors — team connectors (shared or per-member credentials) and personal connections with OAuth, one `mcp_call` tool, per-tool switches, previews for destructive tools, Activity log records, also for members' agents over `/api/mcp` and for automations
* **automations:** web search on every run, tools granted from a web or phone chat, a "no update" only counts after a tool call; runs sit in their own Scheduled tab of conversation history and in search
* **extensions:** core-generation markers for extension migrations, `db:migrate` runs the extension lane, complete extension kits locked by snapshots, sdk/core compatibility ranges, an import-edge guard, governed write tools
* **mobile:** a redesigned native iOS app — sidebar navigation, home with recent conversations, rich replies, knowledge and Drive with Recent tabs, projects and tasks, scheduled tasks, conversations shared with you, search, connectors, team activity, text sizes and the Haven look
* **web:** Haven tokens shared with mobile, object / file / domain link chips, plant avatars, stats / cards / steps blocks

### Removed

* the workbench, table forms / dashboards / in-table automations, the desktop app and the browser extension

### Notes

* Upgrading from 1.6: run `pnpm cli migrate-from-1x --from <1.6 database> --to <new database>` into a new, empty database, then `pnpm db:migrate`. The 1.6 database is only read.

## [1.6.0](https://github.com/linjiejim/greenhouse/compare/v1.5.0...v1.6.0) (2026-10-24)


### Added

* **metering:** price every paid call in USD (models, search, page reads, images, vision, cloud computer) with organization, service and member budgets, 80%/100% alerts, refusals that tell the agent why, admin-set prices, and the Services & pricing page plus Settings › Usage
* **gateway:** model gateway for members' own agents: per-member keys, OpenAI-compatible and Anthropic-compatible endpoints (Claude Code, Cursor, SDKs), metered like everything else; off by default
* **mcp:** web_search, read_url, analyze_image and generate_image for members' agents, metered and recorded
* **computer:** on-demand cloud computer per member on E2B (off by default, idle stop, per-minute billing, MCP computer tools)
* **reports:** team report templates rendered server-side to PDF, Word and PowerPoint into Files, for agents, chat and automations
* **context:** team conventions, glossary, SkillHub prompts and an overview served to agents over MCP (prompts, resources, team_context), a monthly retro doc, a data catalog and a per-client connect wizard
* **mobile:** native Expo SDK 57 app for the team hub — notifications and push, knowledge, Files with share-to-Greenhouse, projects and tasks, tables, my agents, assistant, widgets, iPad split view, offline reading, Feishu sign-in

### Notes

* MCP knowledge resources now follow the grant's knowledge scope; an older grant without it must re-consent to read knowledge resources.
* Local DB test runs require TEST_DATABASE_URL (only CI keeps the default).

## [1.5.0](https://github.com/linjiejim/greenhouse/compare/v1.4.0...v1.5.0) (2026-10-23)


### Added

* **activity:** turn the Execution Center into the Activity log (操作记录) ([4574d95](https://github.com/linjiejim/greenhouse/commit/4574d9555ab31dd61b779e01ce321c556057bae4))
* **api:** deliver notifications to phones through the Expo Push Service ([4ae23ff](https://github.com/linjiejim/greenhouse/commit/4ae23ff78e2be0f9b51aeb114b6b7d59758b3eea))
* **automations:** fold My Agents into Automations as Run profiles ([ccb07cf](https://github.com/linjiejim/greenhouse/commit/ccb07cf5b2ce9b283905a0b074c7f30037e8d3a1))
* **automations:** run an automation as a run profile ([0bc9438](https://github.com/linjiejim/greenhouse/commit/0bc9438d9a8fb12d8578552075309dc2a1b961fb))
* **chat:** keep the workbench cards on Home only ([12a8037](https://github.com/linjiejim/greenhouse/commit/12a80374dd89875a04e48528ce90bad1a49424b0))
* **db:** push_devices for mobile push, and a suppressed delivery status ([f28bd14](https://github.com/linjiejim/greenhouse/commit/f28bd1402d057763cea58acce4dbd9c38523aff4))
* **feedback:** merge requests and frictions into Issues & requests, open them to MCP ([92488cd](https://github.com/linjiejim/greenhouse/commit/92488cd88a16bc90a67a9ab192c957cd68177834))
* **files:** add Files (档案库) page and files tools for members' agents ([f5f90fc](https://github.com/linjiejim/greenhouse/commit/f5f90fc1313ec20a6ab01f441bf986e55ef558f7))
* **home:** make Home the team's recent changes (团队动态) ([370ab24](https://github.com/linjiejim/greenhouse/commit/370ab248a01c1fee5090560ced6fd8dce551ce54))
* **mobile:** the team-hub app on Expo SDK 57, with notifications and push ([cf72adf](https://github.com/linjiejim/greenhouse/commit/cf72adf0e0b9596ef1cfb2f561f1dc0d2422be5f))
* **skillhub:** fold My prompts into SkillHub as a tab ([a88cbb3](https://github.com/linjiejim/greenhouse/commit/a88cbb3af3f8f69f455d3eefa7379b7947acae83))
* **web:** order the navigation by goal ([4182fbc](https://github.com/linjiejim/greenhouse/commit/4182fbc88d817cd58e5661bc47c6b7555864f394))


### Fixed

* **activity:** name a comment by the task it is on ([6495726](https://github.com/linjiejim/greenhouse/commit/6495726d7d542e67a78e3b48b7a16c55f5e75a89))
* **activity:** name an agent write's document only for a viewer who may read it ([c97a120](https://github.com/linjiejim/greenhouse/commit/c97a1208e42ae17fc3c14259e2653d5666589a47))
* **activity:** say what each change did to which object, the same on Home and in the Activity log ([750ae01](https://github.com/linjiejim/greenhouse/commit/750ae0114d20fe26e0147e3f3cb36bbec63283ed))
* **automations:** make the Run profiles tab speak run profiles, with one tab row ([b82a3ef](https://github.com/linjiejim/greenhouse/commit/b82a3ef49d407921993017ec3d1824ea9ec078d4))
* **automations:** offer the owner's run profiles when a super edits a member's automation ([dbc2042](https://github.com/linjiejim/greenhouse/commit/dbc204235b6f5a330430faf8dc6e77faf9f94c3e))
* **automations:** say when the owner's run profiles fail to load and offer a retry ([a3c4df1](https://github.com/linjiejim/greenhouse/commit/a3c4df1a70d6bfb7fb8de76072cf86a77f069209))
* **files:** label search hits by shelf and reopen a deep-linked preview ([dd819eb](https://github.com/linjiejim/greenhouse/commit/dd819eb2c477243d3ffa13998a356e1526c11dd9))
* **home:** authorize only the tasks the feed names, with lookups made once ([1a1dd41](https://github.com/linjiejim/greenhouse/commit/1a1dd414b4d7558e04618ebdf65abb4b297f3f1c))
* **home:** draw the feed's loading state with divs, not table rows ([fdf246e](https://github.com/linjiejim/greenhouse/commit/fdf246e1b5f54b66770905fadedba59fadc11081))
* **home:** show task changes only through the task-aware listing ([aa8b094](https://github.com/linjiejim/greenhouse/commit/aa8b09467960571bd001421d1225c62d942125ab))
* **mcp:** announce log_friction as destructive again and drop mcp_additive ([b447d5d](https://github.com/linjiejim/greenhouse/commit/b447d5d696cb244a31510d623961d67f4fc5b38c))
* **mcp:** let an add-only write tool say so, and mark log_friction additive ([76a843d](https://github.com/linjiejim/greenhouse/commit/76a843d3a8004286fc94177aab1464f060617d6e))
* **mobile:** a late member lookup never clears another station's sign-in ([cf9362b](https://github.com/linjiejim/greenhouse/commit/cf9362b1928ddaea4d5ad6a59fcfcc2be19bec84))
* **mobile:** ask about pushes only after the app comes back from a sign-in ([19f0c92](https://github.com/linjiejim/greenhouse/commit/19f0c9240681926d2095fa948f05963f2c780882))
* **mobile:** clear only the banners of notifications known to be read ([d0610d5](https://github.com/linjiejim/greenhouse/commit/d0610d50bf43a8a232d83c5c0e5f93a6c4a8354b))
* **mobile:** keep loading and coming-soon states under the large title ([0e2aa5c](https://github.com/linjiejim/greenhouse/commit/0e2aa5ce5f11430083ccff36ea59d2410b3c25a8))
* **mobile:** keep the banner and say so when opening cannot mark it read ([1abab94](https://github.com/linjiejim/greenhouse/commit/1abab9449383fbe25db5421c5af647da45f6350e))
* **mobile:** page on after a refresh that replaces the offline copy ([9c31991](https://github.com/linjiejim/greenhouse/commit/9c31991d9f1d7fe007e0be595758f286b7d4c10f))
* **mobile:** readable status tiles in dark mode ([f249fa4](https://github.com/linjiejim/greenhouse/commit/f249fa4a10e84a3aa648f5a9aa94f158c1aef3fb))
* **mobile:** switching pushes off wins over a registration in flight ([55c1323](https://github.com/linjiejim/greenhouse/commit/55c1323722d4093edc96d9627b7512b01e32d4a8))
* **notifications:** point runtime notices at the Activity log, in the reader's language ([25fdb12](https://github.com/linjiejim/greenhouse/commit/25fdb128be66386642760a015ddb2f464349cf34))
* **skillhub:** call the My prompts tab's items prompts, not tasks ([b4abdaa](https://github.com/linjiejim/greenhouse/commit/b4abdaa15b423957ebf619224acb1eb323f37675))
* **web:** one tab row and one rhythm across the new module pages ([082a59b](https://github.com/linjiejim/greenhouse/commit/082a59b189bc3e0cb019f5d2efda0f01c1f4a712))
* **web:** resolve retired hashes in the router so the sidebar lights where you landed ([608eac3](https://github.com/linjiejim/greenhouse/commit/608eac30ab7f773133d988edbba09772372d93e9))
* **web:** retire leftover copy for removed features and align wording with the agent hub ([332ad86](https://github.com/linjiejim/greenhouse/commit/332ad861abb87f8b0df902a0faa2c604cb44d8fb))
* **web:** say 团队 Agent 中台 in the Chinese sidebar tagline ([42b2cb7](https://github.com/linjiejim/greenhouse/commit/42b2cb76b6d5c71668f41041f9e0151f002c0424))


### Changed

* **browser:** remove the browser extension ([5cd15f0](https://github.com/linjiejim/greenhouse/commit/5cd15f004b6daa331674f550c64c979e151b5fa0))
* **desktop:** remove the desktop app ([d36d8dd](https://github.com/linjiejim/greenhouse/commit/d36d8dd4a02089bdadeba33f8ebcc7b2b7509a7c))
* **runtime:** remove sub-sessions ([62da89e](https://github.com/linjiejim/greenhouse/commit/62da89e38adae3a184c7a4c2819ed9a443fb2336))
* **sessions:** remove session tags and session groups ([9861570](https://github.com/linjiejim/greenhouse/commit/9861570ff8ad7d94aea8327f0343def9d2b2f712))

## [1.4.0](https://github.com/linjiejim/greenhouse/compare/v1.3.3...v1.4.0) (2026-10-23)


### ⚠ BREAKING CHANGES

* **mcp:** agents write as their member; Greenhouse records, it does not hold
* **agents:** POST /api/profiles/custom/:id/lifecycle is gone and profile responses no longer carry lifecycle_status, lifecycle_note, published_version, reviewed_by, reviewed_at or next_review_at. Rows whose retired lifecycle was archived or suspended become visible to their owners again.
* **mcp:** govern external agent writes with risk tiers, approvals and standing grants
* remove Workflows
* /api/missions, /api/cloud-agent, /api/llm, /api/auth/llm-keys and /api/admin/llm-gateway are gone; relay keys and task tokens no longer authenticate.
* **api:** /api/eval/*, the session eval endpoints, the eval tools and `pnpm cli eval` are gone; eval_refs is no longer accepted or returned by the custom Agent API.

### Added

* **admin:** audit workspace settings and feature-toggle writes ([0eada17](https://github.com/linjiejim/greenhouse/commit/0eada17f11eeea2cc187c003d1193f17655c9c2f))
* **api:** session_query searches message text and the current conversation ([3a64ae4](https://github.com/linjiejim/greenhouse/commit/3a64ae47fc192422dd5c30d21a74c32c274e20b0))
* **auth:** keep Feishu and WeCom login state in the database ([dad3f1a](https://github.com/linjiejim/greenhouse/commit/dad3f1a5c70ff1f5898f27e36e9595b9166613a8))
* **automations:** 15-minute floor, quiet runs and outcome-unknown crash surfacing ([dd7e1f5](https://github.com/linjiejim/greenhouse/commit/dd7e1f573467c804cfa16cbf5776e522a4d0cdfb))
* **chat:** cache-first prompt and a rolling conversation digest ([b680424](https://github.com/linjiejim/greenhouse/commit/b680424572f2a6e1a9e6dd852b852f95202ea281))
* **db:** rolling-digest compare-and-set, reset on edit and message content search ([da8a8c2](https://github.com/linjiejim/greenhouse/commit/da8a8c279656492e148994ac82263cc3bb6c722e))
* **db:** tables for agent write grants, usage counts, shared security state and session digests ([16a63bd](https://github.com/linjiejim/greenhouse/commit/16a63bddbe262e4cc933af782749bba1eb04249c))
* **knowledge:** push knowledge.changed when a document is written ([9f5fb50](https://github.com/linjiejim/greenhouse/commit/9f5fb5002c285202683df4ee0595723befe4065b))
* **mcp:** agents write as their member; Greenhouse records, it does not hold ([892e31d](https://github.com/linjiejim/greenhouse/commit/892e31da6fa0afbc26fbf743228f3acbac810de7))
* **mcp:** bound oversized tool replies and page them with tool_output_read ([0535394](https://github.com/linjiejim/greenhouse/commit/0535394364d1dfffba41872a9ede694d9da5aeba))
* **mcp:** govern external agent writes with risk tiers, approvals and standing grants ([f8733ec](https://github.com/linjiejim/greenhouse/commit/f8733ecd5f1e97d06f3b5adde202d7224950bc30))
* **mobile:** label requests and report module opens for usage counts ([020d604](https://github.com/linjiejim/greenhouse/commit/020d604c856d2674757eecbdd4aed985af0d1b46))
* **security:** keep rate-limit counters in the database ([98cb4f0](https://github.com/linjiejim/greenhouse/commit/98cb4f0d1223381ca0a31b7d0d5c006a840dc8ab))
* **usage:** count tool calls and page opens per module ([aa460c8](https://github.com/linjiejim/greenhouse/commit/aa460c8e13f7e71eaa177d15a544f4ab0985ca39))
* **web:** Settings › Agent connections — approvals, standing grants, activity, connect guide ([2df22dc](https://github.com/linjiejim/greenhouse/commit/2df22dc6a990259c0baa9cccf139f7809f696c99))


### Fixed

* **agents:** only the current version for non-owners; share toggle on phones ([9f07507](https://github.com/linjiejim/greenhouse/commit/9f0750717f780a08358f58bd7f824a7a131563c2))
* **mcp,agents:** Codex round 3, plus what the live approval run showed ([dd08476](https://github.com/linjiejim/greenhouse/commit/dd08476b7727c2e20a88a9b1936e353d95038414))
* **mcp,knowledge:** recheck the source tool on paged reads; keep the tree on live refresh ([bb9470e](https://github.com/linjiejim/greenhouse/commit/bb9470ea251b8b35cb63d01e1ec86e32a3482cd2))
* **mcp:** close the approval races Codex found in governed writes ([0839075](https://github.com/linjiejim/greenhouse/commit/0839075238d83b5ebdecf6b1dc4238fab3cbdbeb))
* **mcp:** keep migration 0008's timestamp; mark editing tools destructive ([ef5e234](https://github.com/linjiejim/greenhouse/commit/ef5e234207e2ad75283960fef44018be1f22e303))
* **mcp:** name a write's document only when its owner may read it ([b2e3c24](https://github.com/linjiejim/greenhouse/commit/b2e3c240b1a48dd77da246fc603f87b531e820d7))
* **web:** keep approve and reject together on phones ([42b323b](https://github.com/linjiejim/greenhouse/commit/42b323bf0e07484c82a26056908ad4d0d34491ec))
* **web:** keep conversations, gantt and approval cards readable ([39a2fef](https://github.com/linjiejim/greenhouse/commit/39a2fef7820934bf3ce15f9c2198b8c64d3f4bdb))
* **web:** label agent writes in the Execution center ([ead3260](https://github.com/linjiejim/greenhouse/commit/ead3260d302951ac793cb37254a242d9b22e28e9))
* **web:** one button, toolbar and page-column rule across the app ([0eb628b](https://github.com/linjiejim/greenhouse/commit/0eb628b78290aa5a85f2dcaff922b9c76fd17bc8))
* **web:** one page padding for every ModulePage layout ([bee01c1](https://github.com/linjiejim/greenhouse/commit/bee01c16a2c702aa5c2d1be220be1a6c03ed0c01))


### Changed

* **agents:** replace the custom-agent review lifecycle with super-switched team sharing ([c7c7e15](https://github.com/linjiejim/greenhouse/commit/c7c7e159fb8313c7f4821f52337bccd0e8602037))
* **api:** remove the evaluation system ([099fecf](https://github.com/linjiejim/greenhouse/commit/099fecfd0aadd36cf3713e42c1fc362d8f871ea9))
* remove Missions and the LLM relay ([b8f3c16](https://github.com/linjiejim/greenhouse/commit/b8f3c16b8db38c0d7b3a560f56fa1ca7f33b1655))
* remove Workflows ([86d5747](https://github.com/linjiejim/greenhouse/commit/86d5747c5927765ae87f620b4824d7f3153507a1))
* **types:** share the agent write wire types between API and web ([ab7818a](https://github.com/linjiejim/greenhouse/commit/ab7818a7b532d6bc86c36813fb8e0546a1a4bc96))

## [1.3.3](https://github.com/linjiejim/greenhouse/compare/v1.3.2...v1.3.3) (2026-10-22)


### Fixed

* **agent-core:** catch the `<｜｜DSML｜｜ calls>` leak variant ([0051bfa](https://github.com/linjiejim/greenhouse/commit/0051bfa7505b5d5faf8a58b7c0f25e22dd05722e))
* **api:** guard search-result page fetches against SSRF ([5110c2b](https://github.com/linjiejim/greenhouse/commit/5110c2b05589f5f9db6ea6d97f2b7088b7f5915b))
* **api:** keep the API up when a database blip hits a WebSocket connect ([aff78b5](https://github.com/linjiejim/greenhouse/commit/aff78b5bc02999bcb280116311401485ccdfe69c))
* **api:** session reads escape the login rate limit ([5d0e652](https://github.com/linjiejim/greenhouse/commit/5d0e652b5a74d452a9819c012feaae26c81c4ad9))
* **feishu:** a reply in the chain carries the conversation to the model ([cb5a400](https://github.com/linjiejim/greenhouse/commit/cb5a4005aad17e1731b2b7df0fee76d0d1538498))
* **web:** the OAuth consent screen no longer re-renders forever ([ad56e27](https://github.com/linjiejim/greenhouse/commit/ad56e27dda57301b0a81521e596a0b8db6a5bfde))
* **web:** the MCP Access page no longer re-renders forever ([5a9c818](https://github.com/linjiejim/greenhouse/commit/5a9c818f44a257717e8297b82e08d4ee3274269d))
* **web:** sanitize exported answers and sandbox the PDF print frame ([#44](https://github.com/linjiejim/greenhouse/issues/44)) ([567cb83](https://github.com/linjiejim/greenhouse/commit/567cb83b8145cf5aedf90e442a3cbfa3daecde31))

## [1.3.2](https://github.com/linjiejim/greenhouse/compare/v1.3.1...v1.3.2) (2026-09-24)


### Changed

* **api:** keep the chat route off the tool catalog ([#34](https://github.com/linjiejim/greenhouse/issues/34)) ([9163ba0](https://github.com/linjiejim/greenhouse/commit/9163ba0a065bdbb9de7ce37d568ff73613fccc94))

## [1.3.1](https://github.com/linjiejim/greenhouse/compare/v1.3.0...v1.3.1) (2026-09-24)


### Fixed

* **browser:** put the extension back on the current chat contract ([#30](https://github.com/linjiejim/greenhouse/issues/30)) ([7bfb3a5](https://github.com/linjiejim/greenhouse/commit/7bfb3a5b2573b58eadf453a85f1ec0e74aaddb39))

## [1.3.0](https://github.com/linjiejim/greenhouse/compare/v1.2.0...v1.3.0) (2026-09-23)


### Added

* **media:** image generation can use its own endpoint (IMAGE_BASE_URL + IMAGE_API_KEY) ([6010590](https://github.com/linjiejim/greenhouse/commit/601059045fbbbfcc9389b8ccdafa822ff3098d01))
* **models:** DeepSeek-only catalog; the default model reads attached images ([844ef94](https://github.com/linjiejim/greenhouse/commit/844ef949ae5c0a18c0d4f6d03b3349d9c603d45d))


### Fixed

* **chat:** run a retired or unkeyed model choice on the default instead of failing ([72e7a48](https://github.com/linjiejim/greenhouse/commit/72e7a483a850ed55c7a0e71857b55d7104ac84a8))
* **desktop:** ignore Apple signing variables a CI runner left empty ([19d2d5e](https://github.com/linjiejim/greenhouse/commit/19d2d5e102fcd5710576ebdcc2310e191c569708))
* **web:** the Agent editor shows and saves the default for a retired model ([54ad249](https://github.com/linjiejim/greenhouse/commit/54ad249e8dbba3ef270abaa9789a154823403cc0))

## [1.2.0](https://github.com/linjiejim/greenhouse/compare/v1.1.0...v1.2.0) (2026-09-16)


### Added

* **desktop:** Tauri desktop shell with signed hot updates, configured per deployment by environment ([da114c9](https://github.com/linjiejim/greenhouse/commit/da114c9d8e9a9adade82574487997fabddcc7641))


### Fixed

* **agent-core:** build DeepSeek-backed openai-compatible entries with the DeepSeek client ([15bcb3f](https://github.com/linjiejim/greenhouse/commit/15bcb3f780915eb786d055e01a1ed979e9f7acf5))
* **desktop:** pass the Tauri config overlay as a file, not inline JSON ([86bf439](https://github.com/linjiejim/greenhouse/commit/86bf439aafb1b38a92d066c0d99c622736b7a23c))

## [1.1.0](https://github.com/linjiejim/greenhouse/compare/v1.0.0...v1.1.0) (2026-09-15)


### Added

* **web:** extension page aliases replace the hard-coded legacy redirects ([e6c89dd](https://github.com/linjiejim/greenhouse/commit/e6c89dd4ac7e4115f623a3ab7afb154646f29fc6))


### Fixed

* **extensions:** refuse a tool core could never build; hand lazy tools the unattended flag ([4d3364c](https://github.com/linjiejim/greenhouse/commit/4d3364c7d6b3f2cf92cff544d12cd873567b4a66))
* **mission:** hand the relay's per-model output caps to the sandbox runner ([acd4914](https://github.com/linjiejim/greenhouse/commit/acd49149f12b50347f573f1f2d2572d5fc58ac83))
* **mission:** stop retrying containment when there is no docker CLI at all ([d9676ed](https://github.com/linjiejim/greenhouse/commit/d9676edb4797dde0be0c0d514efe333920808c8b))
* **web:** give extension administration modules core's `admin.<key>` id ([399222b](https://github.com/linjiejim/greenhouse/commit/399222ba69a5376683fadb2492cc20db4c2efd79))

## [1.0.0](https://github.com/linjiejim/greenhouse/compare/v0.6.0...v1.0.0) (2026-09-14)


### ⚠ BREAKING CHANGES

* **db:** the public /api/v1 surface, guest accounts and the database-managed LLM gateway upstreams are removed; models come from apps/api/src/config/models.yaml.

### Added

* **agent-core:** env-derived registry, provider quirks and run guarantees ([3e59338](https://github.com/linjiejim/greenhouse/commit/3e593389f87286f9d9e56822897629ac46b1c11c))
* **agent-runner:** mission sandbox runner image ([722ae65](https://github.com/linjiejim/greenhouse/commit/722ae6558aeb1eb916df91985cce5265438eeebf))
* **api:** extension seam — one object per extension, aggregated into every registry ([38182a4](https://github.com/linjiejim/greenhouse/commit/38182a4b73870a5c8c8bb03c9b44e3e9085c877c))
* **api:** platform kernel host, tables, runtime kernel, missions and integrations ([6d38b37](https://github.com/linjiejim/greenhouse/commit/6d38b3771d2a99610e2deaf483da4a5ee6234089))
* **cli:** db baseline --through stops short of the end of a chain ([cb3ef52](https://github.com/linjiejim/greenhouse/commit/cb3ef5284b5b778f9c52aa0c91d5a2b4862098ac))
* **cli:** db baseline refuses to record migrations whose tables are absent ([3a7e24b](https://github.com/linjiejim/greenhouse/commit/3a7e24bd62abe13dbf7b5a5d8e07fd0d6c111c38))
* **clients:** typed station config with a single-station lock ([a5162be](https://github.com/linjiejim/greenhouse/commit/a5162be4efcef2e0bfb45be167796257241301bf))
* **config:** typed greenhouse.config.ts, validated at boot ([364d004](https://github.com/linjiejim/greenhouse/commit/364d004adab26ad34812cb30a54b4a5770c80c77))
* **crud,ui,knowledge-editor:** interaction standard and editor updates ([33b8fa2](https://github.com/linjiejim/greenhouse/commit/33b8fa25115a63e21217f339bf4e497c482e1af2))
* **db:** extension services, reset tables and a checksummed migration lane ([295275c](https://github.com/linjiejim/greenhouse/commit/295275c8e094661adb93ff0e215560e65947a240))
* **db:** platform-line schema, services and migration 0006 ([9ecd463](https://github.com/linjiejim/greenhouse/commit/9ecd46398570d5de32977973b30db474f9ed7112))
* **drive:** extensions can own a drive scope ([3a3cc04](https://github.com/linjiejim/greenhouse/commit/3a3cc0443be429da484715859e46f231bd795654))
* **extensions:** declare a dependency on another extension ([a2458a3](https://github.com/linjiejim/greenhouse/commit/a2458a3c63f9dd595b25350c755c2a5aa0c68b68))
* **extensions:** export sources and application-backed tool visibility ([a7508cf](https://github.com/linjiejim/greenhouse/commit/a7508cf2bc95ec551cbfe78df51e066b83f45d19))
* **extensions:** open the last four shared registries — record kinds, search, MCP groups, workbench cards ([80d299b](https://github.com/linjiejim/greenhouse/commit/80d299bd688ed925926a4b4bf2a71b70c333f789))
* **platform-kernel:** manifest v2, actor context, authorization and registry ([f00c371](https://github.com/linjiejim/greenhouse/commit/f00c371466c62c6d400b5fe266da5fac9d05f9b9))
* **platform:** applications declare which entities the team role may export ([aa058f1](https://github.com/linjiejim/greenhouse/commit/aa058f159ebae6352293c8881258cbd0a5bcc9a0))
* **scripts:** screenshot tour that doubles as a browser smoke test ([7f863fa](https://github.com/linjiejim/greenhouse/commit/7f863fae216f685cb6e43d296e25515a3c009f7a))
* **skills:** first-party skill pack directory and sync script ([e773f66](https://github.com/linjiejim/greenhouse/commit/e773f66da558a86cdf750e4915aa13948a9a9d9e))
* **types,utils:** shared registries and helpers for the platform line ([2e22e7c](https://github.com/linjiejim/greenhouse/commit/2e22e7c625995e448cfa9c43f2bbce07a1a78625))
* **web:** extension pages can declare their own sub-modules ([5821770](https://github.com/linjiejim/greenhouse/commit/58217705a4ff7b91a5fe927133d374c31b3648d6))
* **web:** extension seam — pages, navigation, modules, copy, cards and agent context ([8ab9224](https://github.com/linjiejim/greenhouse/commit/8ab92243a2c5178745c082ad06dc0e7cc5004411))
* **web:** platform catalog shell, tables, execution center and chat upgrades ([3089011](https://github.com/linjiejim/greenhouse/commit/30890118c1873ddd2d87ee68ba12b4a96b13d570))


### Fixed

* **agent-core:** guarantee a final assistant answer when tool loops end with no text ([#21](https://github.com/linjiejim/greenhouse/issues/21)) ([14ff075](https://github.com/linjiejim/greenhouse/commit/14ff0750dd314ac977d91e8480580e363f17c5a6))
* **build:** the web build failed in a clean environment ([f56a607](https://github.com/linjiejim/greenhouse/commit/f56a6073d66b3a08dbd1207aa3ef4af6800b4c4b))
* **cli:** baseline's table check has to net creates against later drops ([77d8222](https://github.com/linjiejim/greenhouse/commit/77d8222b7a73c32cb54ea4393e2552ed3f10a8be))
* **cli:** db baseline took its confirmation arguments in the wrong order ([5b2322f](https://github.com/linjiejim/greenhouse/commit/5b2322f927d87867c1330aeff9c83bc0b95134bb))
* **drive:** folder creation dropped the extension owner key ([436d2cf](https://github.com/linjiejim/greenhouse/commit/436d2cf4b343afa7fbd95cbac5541e260e6328bb))
* **extensions:** type userRole on the search and drive seam contexts ([d1a7a6b](https://github.com/linjiejim/greenhouse/commit/d1a7a6bb74f59deaaa9c896d400ff15b9d38c9ff))
* **lint:** pin the typescript-eslint project root ([90d04e4](https://github.com/linjiejim/greenhouse/commit/90d04e45973e76194d1344ff3820a6225d12c1f7))
* **platform:** derive application gating from the feature-point registry ([d3b13af](https://github.com/linjiejim/greenhouse/commit/d3b13afe916ccebcca7fd47ceb041e12bc85b2be))
* remove the strings, helpers and navigation left behind by the private modules ([865af69](https://github.com/linjiejim/greenhouse/commit/865af697dc9f1565c84a901148b5409bd9b14d32))
* **scripts:** the overlay guard's ** only matched one directory level ([aa28f08](https://github.com/linjiejim/greenhouse/commit/aa28f0865aa7df5550cbf9c4bc2fe4adb1e8ab30))
* **seed:** drop the retired read_at field from session shares ([d0f4f8d](https://github.com/linjiejim/greenhouse/commit/d0f4f8d37dd868d5451410ffcaf448e63635a924))
* **web:** keep chat header actions clear of the title on phones ([58d6a7f](https://github.com/linjiejim/greenhouse/commit/58d6a7f7a01be2f03d9b679cc94358c3ad677977))
* **web:** localized automation times, plain-text inbox previews, wrapping MCP scopes ([1f35dbf](https://github.com/linjiejim/greenhouse/commit/1f35dbfb4522abe29169fa036e0e9368b40cca6a))


### Changed

* **api:** group the flat domain files into chat/, knowledge/, profiles/, security/, sessions/ and drive/ ([d6edeb4](https://github.com/linjiejim/greenhouse/commit/d6edeb43206f4e55eaf8c03c32b5872b0ca18d1a))
* release 1.0.0 ([91f7850](https://github.com/linjiejim/greenhouse/commit/91f78509824c40673e569c5a7ca5afe44845d942))
* **tests:** move the loose test files under tests/api and refresh doc paths ([fede0fa](https://github.com/linjiejim/greenhouse/commit/fede0fa1e785190a58e61d49cdc2e3010ed3942a))
* **web:** administration panels under pages/administration, executions/ and top-level tasks/automations ([2a841e9](https://github.com/linjiejim/greenhouse/commit/2a841e9c1bfc24d2b2aaea6a8a2d253c3d6d6668))

## [0.6.0](https://github.com/linjiejim/greenhouse/compare/v0.5.0...v0.6.0) (2026-07-09)


### Added

* **crud:** unify settings admin pages on @greenhouse/crud ([#18](https://github.com/linjiejim/greenhouse/issues/18)) ([b207c1b](https://github.com/linjiejim/greenhouse/commit/b207c1b916d6db35050a813a1553f5eeba556fb5))
* **workspace:** admin-editable branding, runtime keys & Sprouty DSL ([#11](https://github.com/linjiejim/greenhouse/issues/11)) ([80b5b3e](https://github.com/linjiejim/greenhouse/commit/80b5b3ebbb86e3b3b90b4dbd238149285e66fe14))


### Fixed

* **db:** bump renumbered workspace_settings migration timestamp so migrated databases apply it ([7093c70](https://github.com/linjiejim/greenhouse/commit/7093c70c21f7971e6f9d042f056b90711d1ce083))

## [0.5.0](https://github.com/linjiejim/greenhouse/compare/v0.4.0...v0.5.0) (2026-07-08)


### Added

* **mobile:knowledge:** native editing, version history, scope tabs ([0a33de6](https://github.com/linjiejim/greenhouse/commit/0a33de61f4b026bc5cd69caa20ae1811daa23041))
* **mobile:projects:** project management — list, board, touch-native gantt ([#16](https://github.com/linjiejim/greenhouse/issues/16)) ([e57fbf9](https://github.com/linjiejim/greenhouse/commit/e57fbf9e774b3b5183fef87fa6b261b2a3e864c3))


### Fixed

* **mobile:sheet:** never let the keyboard push sheets off-screen ([31b5e3e](https://github.com/linjiejim/greenhouse/commit/31b5e3e569c4958bf58da2beac3e030c942e51a2))

## [0.4.0](https://github.com/linjiejim/greenhouse/compare/v0.3.0...v0.4.0) (2026-07-08)


### Added

* **mobile:** app icon — greenhouse logo (iOS + Android adaptive) ([0bd11dc](https://github.com/linjiejim/greenhouse/commit/0bd11dc67abb0b9d236eb4c3d3319a6969eb3640))
* **mobile:** chat & nav polish — smooth stream reveal, one-row composer, station switcher in drawer ([ff49924](https://github.com/linjiejim/greenhouse/commit/ff4992427a96a00f5658e6161591fe52202e14f5))

## [0.3.0](https://github.com/linjiejim/greenhouse/compare/v0.2.0...v0.3.0) (2026-07-07)


### Added

* **api&web:skills:** add Skill Center for skill sharing & sync ([3cbcccb](https://github.com/linjiejim/greenhouse/commit/3cbcccbf6fd7075ddc4b4fdeea13f3fc09e00470))
* **browser&mobile:stations:** connect to multiple self-hosted servers ([a196615](https://github.com/linjiejim/greenhouse/commit/a196615cd44bb38dce94f0b1b4ac13eaa7fa91be))
* **release:** mobile fingerprint CD + pull-based GHCR compose upgrade ([6188c45](https://github.com/linjiejim/greenhouse/commit/6188c45f932a39302333249b5f65fc9243dfb5d3))


### Fixed

* **ci:** pin continuous-deploy-fingerprint to a main sha ([266117a](https://github.com/linjiejim/greenhouse/commit/266117af52a3544e830758f44eae4dcbadd4dace))
* **ci:** submit new mobile store builds to TestFlight explicitly ([dd1f52e](https://github.com/linjiejim/greenhouse/commit/dd1f52e874021fdcfe01eb6438078f500c7e5666))
* **mobile:** pin ascAppId so --auto-submit resolves non-interactively ([04e7635](https://github.com/linjiejim/greenhouse/commit/04e76350620b2ba83b6aba0782e5dcde7819fb09))

## [0.2.0](https://github.com/linjiejim/greenhouse/compare/v0.1.0...v0.2.0) (2026-07-06)


### Added

* **release:** standardize release pipeline with version automation, container images, browser packaging, and mobile EAS ([93c295a](https://github.com/linjiejim/greenhouse/commit/93c295a672501b4b7e04c0590f4dca71bbfda436))

## [Unreleased]

> From here on, this changelog is maintained by [release-please](https://github.com/googleapis/release-please)
> from Conventional Commits. See [RELEASING.md](./RELEASING.md).

### Added

- Release engineering: automated versioning via release-please (Release PR → tag →
  GitHub Release), and a tag-triggered `release.yml` that publishes the container
  image to GHCR (`:X.Y.Z`/`:X.Y`/`:latest` for stable; `:edge`/`:main-<sha>` for
  `main`) and attaches the browser extension zip to the Release.
- `RELEASING.md` maintainer runbook; README "Releases & stability" section + latest-release
  badge; `SECURITY.md` supported-versions table.
- Build version stamp: `Dockerfile` takes `APP_VERSION`/`APP_REVISION` (+ OCI labels)
  and `GET /health` now returns the running `version` + commit `revision`.
- `apps/mobile/eas.json` (EAS Build profiles) + `runtimeVersion` policy for the Expo app.
- Browser e2e suite (Playwright) in `tests/e2e-ui/` — `pnpm test:e2e:ui`. Deterministic
  Chromium specs for login, chat (LLM stubbed), project create, and user create/delete.
- `data-testid` anchors on the login / chat / projects / users surfaces and `role="dialog"`
  on `<Dialog>` / `<ConfirmDialog>` for stable test/automation locators.
- Open-source project files: `CODE_OF_CONDUCT.md`, issue & pull-request templates, this
  changelog.

### Fixed

- `DELETE /api/admin/users/:id` returned 500 on a successful delete. `users.delete` checked
  `result.rowCount`, which the postgres-js driver does not populate; switched to the
  codebase-standard `.returning()` + length check.

## [0.1.0]

- Initial release.
