# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.0.0-rc.3](https://github.com/linjiejim/greenhouse/compare/v4.0.0-rc.2...v4.0.0-rc.3) (2026-10-29)


### Added

* one-click deploy to container platforms (S3 storage, migrate on start, first admin from env) ([#91](https://github.com/linjiejim/greenhouse/issues/91)) ([a99c0c4](https://github.com/linjiejim/greenhouse/commit/a99c0c4c36bad64649e4e17c772334e6eddc8758))


### Fixed

* **docker:** NPM_REGISTRY reaches pnpm 11 ([#93](https://github.com/linjiejim/greenhouse/issues/93)) ([ef47e39](https://github.com/linjiejim/greenhouse/commit/ef47e39fb9c7f5b369f610c6fa2f377027690d95))

## [Unreleased]

### Added

extension-kit: export `resolveStorageS3Config` so plugin stores can reuse the validated core
S3 backend; extend `S3LiteClient` with metadata reads, HEAD and paginated listing.

## [4.0.0-rc.2](https://github.com/linjiejim/greenhouse/compare/v4.0.0-rc.1...v4.0.0-rc.2) (2026-10-28)


### ⚠ BREAKING CHANGES

* Greenhouse 4.0 plugin platform
* Greenhouse 4.0 plugin platform ([#89](https://github.com/linjiejim/greenhouse/issues/89))
* **plugin-host:** kit defineExtension.retiredToolAliases is removed; a stored retired tool id no longer expands at run time. Run db:migrate.
* **db:** stored profile ids are rewritten by 0003 and readers no longer map a stored legacy id; a row written with team after the upgrade fails with "Profile not found". API callers may still send the old ids.
* **ui-tokens:** plugin frontends no longer receive --t-* variables and @greenhouse/ui/tokens/tokens.css no longer exists.
* **api:** POST /api/chat ignores ambient_context, client_actions and client_action_scope_id; /api/client-actions/tool-result is gone and @greenhouse/types/agent-context no longer exists.
* **api:** /api/ws no longer emits presence:* events, and kit connectionManager no longer has getOnlineUsers, getOnlineCount or broadcastToSuper.
* **platform-kernel:** kit resolveEntityPolicy takes only role policies, and the platform snapshots no longer carry userOverrides/userOverride.
* **api:** GET /api/platform/apps, GET /api/platform/me/permissions, GET /api/data-catalog and GET /api/admin/operations/cost-value return 404.
* **api:** POST /api/chat with a session_id but neither messages nor regenerate_assistant_message_id returns 400; resume a live reply with GET /api/chat/runs/:sessionId/stream.
* **db:** migrate legacy 1.x data shapes and drop their readers
* drop config aliases and retired tool names kept for old callers
* **api:** supers that relied on the unscoped list for every member's conversations ask for `scope=team`.
* **api:** drop endpoints and inputs kept for 3.x clients
* **api:** TASK_CENTER_ENABLED is ignored.
* old `#/…` bookmarks and `/classic` open Home; plugin manifests must drop `fallback_url`.
* **client:** require a 4.0 station
* **api:** drop the v1 extensions and entityKinds manifest fields
* remove the classic web client; the universal client is the only web client
* **db:** start 4.0 at a fresh core baseline and upgrade 3.x in place
* **api:** drop the boot-time settle of retired run kinds
* **web:** make Home the new conversation and retire the workbench

### Added

* **admin:** read-only plugin status page and `cli plugins list/status/drop` ([5ef1f41](https://github.com/linjiejim/greenhouse/commit/5ef1f4187c701bfc58b37fae1074fc48ef07973b))
* **api:** a session chat turn needs a new message or a regeneration target ([94d9836](https://github.com/linjiejim/greenhouse/commit/94d9836cd26fe34a3ff232c37dac96599aa2d279))
* **api:** add boolean workspace switches, starting with gateway.enabled ([20253cb](https://github.com/linjiejim/greenhouse/commit/20253cbc181f191e156aaf63fdca548ffa55955a))
* **api:** admin-set prices and audited pricing and budget changes ([2bd348a](https://github.com/linjiejim/greenhouse/commit/2bd348a0d3c253b6e53ef04d1c07b2108f6dfff6))
* **api:** agent connectors field and connector writes in the Activity log ([fbca4ba](https://github.com/linjiejim/greenhouse/commit/fbca4baeefc0f5927b28de1cc33f61aec1288592))
* **api:** connector routes, official catalog and the mcp_call tool ([105c076](https://github.com/linjiejim/greenhouse/commit/105c076d783085d5fba4e5fbb777a8b30cd12607))
* **api:** drop endpoints and inputs kept for 3.x clients ([7e16efb](https://github.com/linjiejim/greenhouse/commit/7e16efb8090de934d46af28a6926a843005b362b))
* **api:** drop the TASK_CENTER_ENABLED kill switch ([83361fa](https://github.com/linjiejim/greenhouse/commit/83361fa52014c3589d1a69898af658edb82a45fb))
* **api:** drop the v1 extensions and entityKinds manifest fields ([764da00](https://github.com/linjiejim/greenhouse/commit/764da006e09e9a20055142657d0a74e203e9e296))
* **api:** expose mcp_call over /api/mcp under the connectors group ([f46e5aa](https://github.com/linjiejim/greenhouse/commit/f46e5aac7b69dc6c94eaebc766224694e56f948e))
* **api:** Feishu sign-in can return to the phone app ([4db510a](https://github.com/linjiejim/greenhouse/commit/4db510aa4eb26652facfb75c8c34ac6e60eb1772))
* **api:** give each member an on-demand cloud computer, billed per minute ([71d71cd](https://github.com/linjiejim/greenhouse/commit/71d71cda1837f5664ad64ff38dbf7210d9bdc1b3))
* **api:** let a model provider declare an Anthropic-compatible endpoint ([afdc8a1](https://github.com/linjiejim/greenhouse/commit/afdc8a120719ed92f73fc9ef12b2a338388957e2))
* **api:** let automations render reports from team templates ([7a40590](https://github.com/linjiejim/greenhouse/commit/7a40590e29de1da2df08699fe58236749b3bf7c7))
* **api:** MCP connector client, network guard, credentials and OAuth sign-in ([60bf4f0](https://github.com/linjiejim/greenhouse/commit/60bf4f00aa827abdffde3487064443331cb30810))
* **api:** member preferences and plant avatars for connected agents ([9a1559c](https://github.com/linjiejim/greenhouse/commit/9a1559c278e413971f10d48c30b1b4378d7ec727))
* **api:** meter every paid call in USD ([8458c9b](https://github.com/linjiejim/greenhouse/commit/8458c9bd3d7efec31dc473e2601b91d9f6f2cdee))
* **api:** open paid web and image services to members' agents over MCP ([a2a49e3](https://github.com/linjiejim/greenhouse/commit/a2a49e3e3e47974bf8a77e8f6825bb26cbecb92d))
* **api:** page team activity with a before cursor ([a40d772](https://github.com/linjiejim/greenhouse/commit/a40d772ef0665d4802c97a6c7f4299c361fe4e36))
* **api:** price models and paid services ([4f81350](https://github.com/linjiejim/greenhouse/commit/4f8135096ccf199c09619c1b53bdf6a57a1ad156))
* **api:** raise the phone app's API level to 3 for 1.7 ([622f484](https://github.com/linjiejim/greenhouse/commit/622f4849d281b78509cc6d34effc6358bf8bbf08))
* **api:** read API for services, spend and budgets ([2b7a23f](https://github.com/linjiejim/greenhouse/commit/2b7a23f8be998ddcf7202c5cc8012267797f1747))
* **api:** refuse a resent chat turn by client_turn_id ([df4ad4d](https://github.com/linjiejim/greenhouse/commit/df4ad4da39383384ec67e8cf17713f98bcb0c059))
* **api:** remove page context and browser Client Actions from chat turns ([3ba1af6](https://github.com/linjiejim/greenhouse/commit/3ba1af6589ed05a848b3f026fbbe73847a9db9f2))
* **api:** remove the unread /api/platform, /api/data-catalog and cost-value routes ([e909ff5](https://github.com/linjiejim/greenhouse/commit/e909ff5263b82710d5b7888646261d4b10821481))
* **api:** render reports from team templates to PDF, Word and PowerPoint ([f29e05b](https://github.com/linjiejim/greenhouse/commit/f29e05bbb8fc6559357a9635b2c9978e0bd81287))
* **api:** serve an OpenAI-compatible model gateway on members' keys ([12d3b3b](https://github.com/linjiejim/greenhouse/commit/12d3b3bb795734ebe216630a9c72b7ffc33909bb))
* **api:** serve team context, a data catalog and a monthly retro to the agent hub ([7b57360](https://github.com/linjiejim/greenhouse/commit/7b57360d98335866d92d94bd05130aa5e776f6d2))
* **api:** serve the model gateway on the Anthropic Messages wire ([8362705](https://github.com/linjiejim/greenhouse/commit/836270512b06b9751db00215e6f972b04487e5fd))
* **api:** server links point at universal client routes, universal is the default web client ([5b9d58e](https://github.com/linjiejim/greenhouse/commit/5b9d58ed1896e441ecb9c41dd8f581c5546fdf88))
* **api:** show members' chosen plant on their connected agents ([1cf348d](https://github.com/linjiejim/greenhouse/commit/1cf348dd5380b4eb0d1c3b52fd1ece8c9007538a))
* **api:** show report template changes in the Activity log ([8333d07](https://github.com/linjiejim/greenhouse/commit/8333d075c11d80219d16d383f48648500f84a48a))
* **api:** station manifest says which transports take a webhook ([4279458](https://github.com/linjiejim/greenhouse/commit/42794580349bd79c9d51d0dd9f42657fb1215397))
* **api:** stop sending online presence over /api/ws ([8ddd2b8](https://github.com/linjiejim/greenhouse/commit/8ddd2b8ee158f075b31f332bc24af769b1524bcd))
* **api:** store client error reports and group them for supers ([cd5732a](https://github.com/linjiejim/greenhouse/commit/cd5732af85eb6b36ec81707972616455a48843ff))
* **api:** the unscoped session list is the caller's own for supers too ([7dc6dea](https://github.com/linjiejim/greenhouse/commit/7dc6deaee66030a27ac0eabc3eff7a8c4a2f780f))
* automations get web search and chat-granted tools; search and history find scheduled runs ([a415198](https://github.com/linjiejim/greenhouse/commit/a4151983b358932a5edcd5f320af0a6bdbcaf28f))
* **automations:** run an automation as a run profile ([0bc9438](https://github.com/linjiejim/greenhouse/commit/0bc9438d9a8fb12d8578552075309dc2a1b961fb))
* **chat:** add stats, cards and steps blocks and per-screen rich_blocks ([816432b](https://github.com/linjiejim/greenhouse/commit/816432b1f4b33014001cbbd14735af21159caeb3))
* **cli:** carry a 1.6 database into 3.0 with migrate-from-1x ([f810467](https://github.com/linjiejim/greenhouse/commit/f8104675e800a3746200f00798078e5f0d092dfd))
* **client:** Admin › Client errors ([a4ea7e5](https://github.com/linjiejim/greenhouse/commit/a4ea7e5a13af1600c88ab902900fcb36b0a88f53))
* **client:** Admin activity log and team context sections ([377b940](https://github.com/linjiejim/greenhouse/commit/377b940600940ccb3dcd6b6db5dae48abd8808a0))
* **client:** Admin branding section with a scoped live preview ([538485b](https://github.com/linjiejim/greenhouse/commit/538485ba669eaf0fa53c783a80f7870cc2d9423a))
* **client:** Admin MCP access and team connectors sections ([bede585](https://github.com/linjiejim/greenhouse/commit/bede585cbe23f3c78a469a2d782dd7520c1275e3))
* **client:** Admin place with sections, opened from the rail, ⌘K and the Go menu ([ae38074](https://github.com/linjiejim/greenhouse/commit/ae380745e450d108982eea776bdb99dbca75c65c))
* **client:** Admin plugins and runtime config sections ([4bc7da0](https://github.com/linjiejim/greenhouse/commit/4bc7da0f878cea99e1ac7a8c75f68c818edf8daf))
* **client:** Admin services & pricing and usage sections ([00cf24f](https://github.com/linjiejim/greenhouse/commit/00cf24f77e34d00489a35ded5fb71b85095bcc76))
* **client:** automation editor and custom agents in the Automations place ([dce683d](https://github.com/linjiejim/greenhouse/commit/dce683d0f159c5f44d7e545313688621a904ecb5))
* **client:** automation schedule, form and custom agent rules ([722dbd3](https://github.com/linjiejim/greenhouse/commit/722dbd31f6fec3bcd57f6bd4b86f70104b7e67e8))
* **client:** Email, Memory and Computer pages with their own screens ([779e946](https://github.com/linjiejim/greenhouse/commit/779e946c9775774257012fbb1f2dd65f7c1c9df7))
* **client:** entry pages for activation, MCP consent, connector and provider returns ([afc88fa](https://github.com/linjiejim/greenhouse/commit/afc88fa8861fee86e63dceccd024970df10b3325))
* **client:** Me creates and revokes gateway keys, guides an agent connection, lists my activity ([5a7e801](https://github.com/linjiejim/greenhouse/commit/5a7e801f04f5ff2be287a7a1b2f41da9d3104de5))
* **client:** members add, edit, refresh and delete connectors of their own ([1e87374](https://github.com/linjiejim/greenhouse/commit/1e8737428962b6f8f93121bc1cef07c4c797f106))
* **client:** project members panel and document share dialog ([ee4e725](https://github.com/linjiejim/greenhouse/commit/ee4e725cbdd73fd136b3508694a93880f17fac70))
* **client:** report caught errors to the station ([49d6642](https://github.com/linjiejim/greenhouse/commit/49d6642b4536b36ccb0e998279ce8919f0ec94cf))
* **client:** require a 4.0 station ([94bab67](https://github.com/linjiejim/greenhouse/commit/94bab67905e60ac7a76dc8573f81363fdd5ba899))
* **client:** sheet forms read as desktop dialogs on wide web windows ([fc79916](https://github.com/linjiejim/greenhouse/commit/fc79916cc2f44f78401c3029f7774dfd98d25f59))
* **client:** table owners delete a base or table from the Tables sidebar ([bb6b9d2](https://github.com/linjiejim/greenhouse/commit/bb6b9d23d6bfd44a8175947dabdfa1d5635a41d1))
* **client:** the browser uploads skills, shows their versions and edits report templates ([36cf49f](https://github.com/linjiejim/greenhouse/commit/36cf49f498d372a20a3b07fbdbd864db520fb8bd))
* **db:** add mcp_connectors, connector_write runs and AAD-bound secrets ([a6c09f8](https://github.com/linjiejim/greenhouse/commit/a6c09f82061dd1f4918feed10a967d936d0976bf))
* **db:** add the report templates table (migration 0013) ([c60e28a](https://github.com/linjiejim/greenhouse/commit/c60e28a6e57965fc899c97ba7b847a704a53fcf1))
* **db:** core-generation markers and db:migrate running the extension lane ([15701ef](https://github.com/linjiejim/greenhouse/commit/15701ef46fb3fbc8c602a7ede0f42eb28c91a271))
* **db:** daily retention cleanup of high-growth tables ([1844c01](https://github.com/linjiejim/greenhouse/commit/1844c013c50f1ce39f8b6a840919054f471eb06b))
* **db:** migrate legacy 1.x data shapes and drop their readers ([ebb2424](https://github.com/linjiejim/greenhouse/commit/ebb24245742de78c506ed82f63fd1efd55382127))
* **db:** rebuild the schema as the 3.0 baseline ([ba762d4](https://github.com/linjiejim/greenhouse/commit/ba762d41b43d492ef9aa0b1e0f5b39a929a5e285))
* **db:** record members' cloud computers in member_computers ([d362f60](https://github.com/linjiejim/greenhouse/commit/d362f600ecd5f32f0e9d21562546d089e978e67f))
* **db:** record the gateway key on each metered model call ([5006771](https://github.com/linjiejim/greenhouse/commit/5006771efe290d7e50bf901756233697498be30a))
* **db:** refuse a half-carried 3.0 database ([ed39d21](https://github.com/linjiejim/greenhouse/commit/ed39d21fcbd7ec918f5f503ce68567dbfa1274a4))
* **db:** start 4.0 at a fresh core baseline and upgrade 3.x in place ([a777149](https://github.com/linjiejim/greenhouse/commit/a77714979c13c95204b8ab3e79a8a04ea9662775))
* **db:** store admin price overrides and the price each call settled at ([0310104](https://github.com/linjiejim/greenhouse/commit/031010493ea6c7674dffedd3cba3e3ebb503c8ac))
* **db:** store metered usage and USD budget limits ([3c6ce8b](https://github.com/linjiejim/greenhouse/commit/3c6ce8b8284802dd7dd748bcbe2603fe7e77e042))
* **db:** store model gateway keys ([58c18b5](https://github.com/linjiejim/greenhouse/commit/58c18b5679eb32a71f170662a4d46924a7c29667))
* **db:** store one canonical profile id and map retired ids at the API edge only ([f1c993e](https://github.com/linjiejim/greenhouse/commit/f1c993e2f161de4914af232a086d8665682676e2))
* **db:** strip the stored workbench layout from member preferences ([6f3973c](https://github.com/linjiejim/greenhouse/commit/6f3973cfe927e34e3ff8772a79c1b7702c07dea0))
* **desktop:** Tauri 2 macOS shell around the universal client ([ed2a64d](https://github.com/linjiejim/greenhouse/commit/ed2a64d09f617e5d08d895bad3a7559547a26d3a))
* drop classic web links ([93d4d05](https://github.com/linjiejim/greenhouse/commit/93d4d05271ee366fd181466b8296f97c1adbb917))
* drop config aliases and retired tool names kept for old callers ([5b762d0](https://github.com/linjiejim/greenhouse/commit/5b762d0eb112bd98f12ee11f64d28cf58dbd3f15))
* **extensions:** a governed write tool in the example, and the docs for the seam ([c9cefce](https://github.com/linjiejim/greenhouse/commit/c9cefcec0a85bd80acd52f30b2e15284e42dc684))
* **extensions:** complete the kits, lock them with snapshots, add sdk/core compat ([0adebfe](https://github.com/linjiejim/greenhouse/commit/0adebfe9b26daea0c6093be48a47c3c5682b40b8))
* Greenhouse 4.0 plugin platform ([fa62bdb](https://github.com/linjiejim/greenhouse/commit/fa62bdb86d16509d0f932b45fce0f2052d9621a6))
* Greenhouse 4.0 plugin platform ([#89](https://github.com/linjiejim/greenhouse/issues/89)) ([fa62bdb](https://github.com/linjiejim/greenhouse/commit/fa62bdb86d16509d0f932b45fce0f2052d9621a6))
* **knowledge:** let agents create missing folders and list the folder tree ([61bf684](https://github.com/linjiejim/greenhouse/commit/61bf6845cbee6226f531520060352ee2ac5c2c15))
* **mobile:** a calmer, livelier conversation page ([bbd7f9a](https://github.com/linjiejim/greenhouse/commit/bbd7f9a3c2cb173751b6d5c88e771af384e8feab))
* **mobile:** a light assistant chat that streams its reply ([5845c15](https://github.com/linjiejim/greenhouse/commit/5845c1551cafb948f19720ba62595cd3688e2f69))
* **mobile:** a rightward swipe anywhere on home opens the sidebar ([ab712be](https://github.com/linjiejim/greenhouse/commit/ab712be250db932c417e46e5f17ba1479891313c))
* **mobile:** a share extension that saves into Files ([ec1b2b0](https://github.com/linjiejim/greenhouse/commit/ec1b2b0f2afcf002f20ea2cfc8bbc191bf330dfc))
* **mobile:** a sidebar instead of the tab bar ([8f1e460](https://github.com/linjiejim/greenhouse/commit/8f1e460cf65d0fee3b862314ffe58ff0edf21b90))
* **mobile:** a still sprout and a status line in the conversation header ([515f782](https://github.com/linjiejim/greenhouse/commit/515f782022ee3656c101ceab3cf24fb461a01648))
* **mobile:** add a station from a + sheet ([3c3770f](https://github.com/linjiejim/greenhouse/commit/3c3770f33c6a014671e6c8e7f1affb0ddee7ba38))
* **mobile:** add and edit project tasks, ask Sprouty first ([bfc30ed](https://github.com/linjiejim/greenhouse/commit/bfc30edc0f337d4de53c954fd9c8676ebc8a42ad))
* **mobile:** an iPad split view for the hub's lists ([8eb84d4](https://github.com/linjiejim/greenhouse/commit/8eb84d46ff1d58eea75705c3f93e99e59058da03))
* **mobile:** app icons in a single rail, plugin pages as places, UI convergence ([e512cf0](https://github.com/linjiejim/greenhouse/commit/e512cf04f356fc9d47fca92c74ba2734fbe1834f))
* **mobile:** compact list pages that refresh in place ([bc83ded](https://github.com/linjiejim/greenhouse/commit/bc83ded3a9ffeb15d3b0e41343afbfd4ff9e2458))
* **mobile:** conversations shared with me, read-only ([767cb3a](https://github.com/linjiejim/greenhouse/commit/767cb3aae7d87081d715ffde345d9dff787bff3a))
* **mobile:** DESIGN.md, Chip and Skeleton, a design guard, and the kit pruned ([a3302d3](https://github.com/linjiejim/greenhouse/commit/a3302d3bdfa37227864a43bf013f1b38ffd48009))
* **mobile:** Drive recent tab, whole-page drawer swipe, top-right add, scheduled history and search ([19fe9ce](https://github.com/linjiejim/greenhouse/commit/19fe9ced7ae8a2adbb0eb39fe6554deea4a6746f))
* **mobile:** every hub place in the drawer, and links that open them ([6ccdef5](https://github.com/linjiejim/greenhouse/commit/6ccdef5ecbdac5181c704d9023d21bd3cb9740b2))
* **mobile:** Haven tokens, tidy ask_user rows and Sprouty empty states ([192e1f9](https://github.com/linjiejim/greenhouse/commit/192e1f91f45bfd27e66f04a58f251685613e1616))
* **mobile:** home lists a few quiet recent conversations ([8002dd4](https://github.com/linjiejim/greenhouse/commit/8002dd4e1a9e80454a0990250a155e91fb60c801))
* **mobile:** home-screen widgets for my tasks and recent documents ([99362d0](https://github.com/linjiejim/greenhouse/commit/99362d09ca093bc63fa9b150ea58d4fc42cb953d))
* **mobile:** home, 「我」 with text size, the search tab and plant avatars ([706bea5](https://github.com/linjiejim/greenhouse/commit/706bea58fcb576a81311fe9ed5000f1020ac98a0))
* **mobile:** home's recent list steps back while writing ([17bfe2f](https://github.com/linjiejim/greenhouse/commit/17bfe2f4cc22b3d15101485f0dcadf3752a441a9))
* **mobile:** knowledge, Files and notifications that open what they point at ([9fa1b25](https://github.com/linjiejim/greenhouse/commit/9fa1b258465813e8023d1ecc25f52ac287be6204))
* **mobile:** my agents with their writes, my spend and gateway keys ([e9884fd](https://github.com/linjiejim/greenhouse/commit/e9884fd8ccc1b5b1e1d978d4ac310d85303fd980))
* **mobile:** native home bar, search on home, a four-tab bar ([8608bcf](https://github.com/linjiejim/greenhouse/commit/8608bcf721d2d3a19c4c688a3f36dc03ac25316a))
* **mobile:** native tabs, and every object opens as a sheet through openObject ([a4b07f0](https://github.com/linjiejim/greenhouse/commit/a4b07f05463eb3d66b07ffdf9f26075b6f82b713))
* **mobile:** one-field composer, no voice input ([68a1123](https://github.com/linjiejim/greenhouse/commit/68a11237fc4cbaf3cd0cae9265bae7b485bc0a8e))
* **mobile:** pick the agent of a new conversation where there is a choice ([0edcdaf](https://github.com/linjiejim/greenhouse/commit/0edcdaf1497178e952ecbc1cec04bd6a9558232c))
* **mobile:** projects with my tasks, task status and comments ([39cde4d](https://github.com/linjiejim/greenhouse/commit/39cde4d6b51525db2a25d9288e6445562a505fb3))
* **mobile:** rail More flyout, fixed-size centered dialogs ([0d7c4e6](https://github.com/linjiejim/greenhouse/commit/0d7c4e6892b5d40060709735b5aed3244bd07b81))
* **mobile:** read a wide table sideways ([a423e62](https://github.com/linjiejim/greenhouse/commit/a423e6227b1562e21a95ad6384f5d2f8a44a7884))
* **mobile:** read my tasks, opened records and files' details offline ([ad8c616](https://github.com/linjiejim/greenhouse/commit/ad8c616c6d209da9c08d26bb09d4722459c47c7e))
* **mobile:** scheduled tasks as a place, made by asking Sprouty ([5cd0db1](https://github.com/linjiejim/greenhouse/commit/5cd0db158aff4048918a665ff1102ec3c6150d86))
* **mobile:** sheets say which conversation they came from ([131e664](https://github.com/linjiejim/greenhouse/commit/131e66408a54be44f187ae78948bd3cb29d11a1a))
* **mobile:** sign in with Feishu when the station offers it ([b2d730c](https://github.com/linjiejim/greenhouse/commit/b2d730c7a79ce93e831c5dc45bbe3d239ef90bca))
* **mobile:** Sprouty on home answers every tap ([8292fd9](https://github.com/linjiejim/greenhouse/commit/8292fd95c0f7fc1aca3be5b7067f585c6920771d))
* **mobile:** Sprouty's one presence is the header ([4e1f71f](https://github.com/linjiejim/greenhouse/commit/4e1f71f8503a7a147f93cd2096445e96576d802b))
* **mobile:** tables with records and a quick add ([c208871](https://github.com/linjiejim/greenhouse/commit/c20887140fb38e5af14f64d69d9bc6855b031ca6))
* **mobile:** team activity in the notifications sheet ([eba8ebb](https://github.com/linjiejim/greenhouse/commit/eba8ebbdc1f2fcc97ca463978fa21d499223040d))
* **mobile:** the conversation page with rich replies, link chips, files and hold-to-talk ([f0be290](https://github.com/linjiejim/greenhouse/commit/f0be2902f64d4fb431a6b66c2c86cabcf101c435))
* **mobile:** the conversations sheet keeps ✕ alone and search on demand ([98cc4e9](https://github.com/linjiejim/greenhouse/commit/98cc4e9a9c648f1939db54db8eae73fa1fc5d86b))
* **mobile:** the Haven mark and app icon ([5097cfc](https://github.com/linjiejim/greenhouse/commit/5097cfc2c1d52aa732c8bee18c1dd52c35da233a))
* **mobile:** the sidebar lies a layer under home, with search in its header ([7097ff6](https://github.com/linjiejim/greenhouse/commit/7097ff6355b54eb59685bbe9f9573aa5d0eacb50))
* **mobile:** the sidebar says which station it is on, and switches ([954607d](https://github.com/linjiejim/greenhouse/commit/954607df94cfadab9ae0cd7175895e1665a21421))
* **mobile:** tool steps start collapsed to one line ([4f6939e](https://github.com/linjiejim/greenhouse/commit/4f6939ea6faf3cf82b62cfd00039927482e2ef63))
* **mobile:** universal client base — web primitives, wide shell, web sign-in ([9952230](https://github.com/linjiejim/greenhouse/commit/995223054bb28ef13fa29ab07f7563c4eae99e72))
* **mobile:** universal client chat main line, inspector stack, ⌘K ([cd9a772](https://github.com/linjiejim/greenhouse/commit/cd9a7727d32ac16eb9813c1d4b61d557cd1ce213))
* **mobile:** universal client places and plugin surfaces ([d95f7e7](https://github.com/linjiejim/greenhouse/commit/d95f7e74a9db21c8ff49c8d71bfe3e94d31b9782))
* **mobile:** 我 → 连接 and the chat connect card for connectors ([aa051e5](https://github.com/linjiejim/greenhouse/commit/aa051e58e497c2cc71c79743f525eac23e658231))
* **mobile:** 知识库 and 云盘 tabs with a path bar and folder actions ([3c79dc5](https://github.com/linjiejim/greenhouse/commit/3c79dc5844a4a5095c441a49b911597362a74e0e))
* **mobile:** 知识库 opens on 最近, with one-line document rows ([3ed346f](https://github.com/linjiejim/greenhouse/commit/3ed346f1c3a14bd3283b50bfb83e5ac1c1739bef))
* **plugin-host:** rewrite retired plugin tool ids in a core migration and drop retiredToolAliases ([774e722](https://github.com/linjiejim/greenhouse/commit/774e722a1793891f0dad52caa10224de04adac4e))
* **plugins:** email, wecom and feishu move out of core ([d9bbf7f](https://github.com/linjiejim/greenhouse/commit/d9bbf7f733765b5fa8ab627e0242359d1a5071af))
* **plugins:** feedback, retro and computer Admin sections in the client ([ebf136d](https://github.com/linjiejim/greenhouse/commit/ebf136d64637fa97f9ea378e50fac49e545f6011))
* **plugins:** knowledge and retro move out of core ([c916f22](https://github.com/linjiejim/greenhouse/commit/c916f221307de19a2cf04ff60e4d09e67200e28a))
* **plugins:** memory, feedback, reports and computer move out of core ([4bd63f9](https://github.com/linjiejim/greenhouse/commit/4bd63f98251d1201d71c55e864a1be20b0d60b7d))
* **plugins:** native pages can be Admin sections, served to supers alone ([8668035](https://github.com/linjiejim/greenhouse/commit/8668035f84f9695989ccddd9b3ad35c326b22375))
* **plugins:** plugin packages under plugins/ assembled by plugins:sync ([36b4f9f](https://github.com/linjiejim/greenhouse/commit/36b4f9fcad429b1425d63f3df5cacd48f35fcdb7))
* **plugins:** plugin page hosting, embed tokens, ui-tokens, /classic switch ([72645fc](https://github.com/linjiejim/greenhouse/commit/72645fc642d65be0a3dc3afa1a631e4ff2786796))
* **plugins:** SDK 2 — data sources, lifecycle events, station manifest v2 ([bd77d02](https://github.com/linjiejim/greenhouse/commit/bd77d0294799c2087689c1ed4e09fdf945d488e8))
* **plugins:** show member names in entity user fields ([aa5066f](https://github.com/linjiejim/greenhouse/commit/aa5066fabf3e13b841fef914c1a3208ff293a76c))
* **plugins:** skills and projects move out of core; agentContext ([b033a26](https://github.com/linjiejim/greenhouse/commit/b033a26a15e10a0cf3dabb38929f7950e2a2616e))
* **plugins:** tables move out of core; open core discriminators ([493db1d](https://github.com/linjiejim/greenhouse/commit/493db1de5a0789a725b42a5cbc1c86a8c8c4744a))
* recent conversations say what they are at ([0cc7ee5](https://github.com/linjiejim/greenhouse/commit/0cc7ee5c4887fcdba6d388467521bdab11287eeb))
* remove the classic web client; the universal client is the only web client ([c5ad216](https://github.com/linjiejim/greenhouse/commit/c5ad2167d500310c959dc8dafeac53305d12c0e1))
* **scripts:** check extension import edges in the overlay guard ([3471805](https://github.com/linjiejim/greenhouse/commit/3471805487af5bc31ab2d70d48b74c556a93c1f2))
* send feedback from the phone ([40adbd5](https://github.com/linjiejim/greenhouse/commit/40adbd5a7ff3b2a2e2552716b129f3d74a7ef2d2))
* team agent hub 1.6 — services & pricing, model gateway, MCP services, cloud computer, report templates, team context, monthly retro, data catalog, native mobile app ([dffa2ed](https://github.com/linjiejim/greenhouse/commit/dffa2edfac681cda6b52a49caf476d5b60c1ee14))
* text sizes down to 0.8 on the phone ([bd6b2f5](https://github.com/linjiejim/greenhouse/commit/bd6b2f54abc11aac143926f456a19cb8349c77b8))
* turn the agent connect guide into a per-client wizard with a connection check ([d5f91ff](https://github.com/linjiejim/greenhouse/commit/d5f91ffe5b51f94291e10bf968d2a02bbf181a23))
* **types:** station manifest v2 wire contract for plugin surfaces ([2f62230](https://github.com/linjiejim/greenhouse/commit/2f6223059aaecc49cb1464044c6d2245c57aa184))
* **ui-tokens:** drop the classic --t-* theme variables ([c880a6c](https://github.com/linjiejim/greenhouse/commit/c880a6c3622a90998400ec663657db2ebee5812e))
* **ui:** dark mode back to deep ink green, on web and mobile ([993e366](https://github.com/linjiejim/greenhouse/commit/993e366064caa20bb57e8abbc9aa743cd7e01bb7))
* **ui:** one Haven token source for web and mobile ([44e5c65](https://github.com/linjiejim/greenhouse/commit/44e5c65fc78c4255502fe05871ffb246e5abd3ac))
* **web:** add Team context admin, a retro button and the data catalog page ([c8fac2c](https://github.com/linjiejim/greenhouse/commit/c8fac2c009f8a493c1f701c6f351880a088358f8))
* **web:** add the cloud computer to Settings and Services & pricing ([66d6503](https://github.com/linjiejim/greenhouse/commit/66d650370a9f00ebb5f51e19ac780d742a7b1a80))
* **web:** bundled Nunito, a 12px floor and 16/26 reading prose ([c746778](https://github.com/linjiejim/greenhouse/commit/c74677890b269e7d7d8164c707ad32f0d54ccc91))
* **web:** calmer chat chrome, flat rich blocks and the Haven intro ([db49cd3](https://github.com/linjiejim/greenhouse/commit/db49cd37f868ff53d97b88faecacc8c46f046419))
* **web:** connectors admin page, settings section, agent field and chat card ([120eeb9](https://github.com/linjiejim/greenhouse/commit/120eeb93d54415cb7d225e8bf7294f6a08babc7e))
* **web:** draw links as object, file and domain chips ([91d7a95](https://github.com/linjiejim/greenhouse/commit/91d7a95c2be1b250c62f822fd150191e2b3d7987))
* **web:** drop Chat from the sidebar list ([4d06012](https://github.com/linjiejim/greenhouse/commit/4d06012eebc31e039beee04f929c2dec00c52976))
* **web:** edit prices and warn about unpriced services ([f5130c4](https://github.com/linjiejim/greenhouse/commit/f5130c4de811ee43344d62cf080cbc0811285651))
* **web:** make Home the new conversation and retire the workbench ([3cb3231](https://github.com/linjiejim/greenhouse/commit/3cb3231dab93425ba57848dd282c3dbe9834c621))
* **web:** manage model gateway keys and show how to connect ([09ac0a1](https://github.com/linjiejim/greenhouse/commit/09ac0a16901687c4ce782539a6b102c3ca2c60eb))
* **web:** manage report templates in SkillHub ([75f5eca](https://github.com/linjiejim/greenhouse/commit/75f5eca51502f5c7cea3cf81cd061c12d0bfea55))
* **web:** replace the Sprouty cartoon with plant avatars ([c97f450](https://github.com/linjiejim/greenhouse/commit/c97f450a4ed816879c81def378d6924e31f0397e))
* **web:** services & pricing page and the member's usage page ([411a759](https://github.com/linjiejim/greenhouse/commit/411a759ddb19e3716dc4dd5609eb58157725ff85))
* **web:** show Claude Code setup and per-key spend for the model gateway ([718f6f9](https://github.com/linjiejim/greenhouse/commit/718f6f94112d3e4f83f5daf5ddf0040eb665c50c))
* **web:** the Haven mark as favicon and app logo ([a3321b0](https://github.com/linjiejim/greenhouse/commit/a3321b077c7ae620ff8c8bdefe7678f91d6e727e))


### Fixed

* **activity:** hold load-more during a refresh; reject malformed cursors ([da28fd0](https://github.com/linjiejim/greenhouse/commit/da28fd0215857db11dbcd68d52dfd4bb54aefb3d))
* **activity:** name a comment by the task it is on ([6495726](https://github.com/linjiejim/greenhouse/commit/6495726d7d542e67a78e3b48b7a16c55f5e75a89))
* **activity:** page the team activity feed on a stable (at, id) cursor ([c774218](https://github.com/linjiejim/greenhouse/commit/c7742187505a52edb8fc27654ce4819c2e1fcf13))
* **activity:** say what each change did to which object, the same on Home and in the Activity log ([750ae01](https://github.com/linjiejim/greenhouse/commit/750ae0114d20fe26e0147e3f3cb36bbec63283ed))
* **agent-core:** keep text from every step; drop temperature under DeepSeek thinking ([d99d7e0](https://github.com/linjiejim/greenhouse/commit/d99d7e089008aab50bb5701e67305b726949e6bb))
* **agent:** stop steering replies toward rich blocks ([f178079](https://github.com/linjiejim/greenhouse/commit/f178079751b07cbe22bba8c43e9b764f62b10459))
* **api:** bound how long a gateway call may wait on its upstream ([0c48b56](https://github.com/linjiejim/greenhouse/commit/0c48b562da9f3a0907a2db0726855be833a2d618))
* **api:** conversation titles follow the first message's language ([0286f4e](https://github.com/linjiejim/greenhouse/commit/0286f4e5f750e4f15a8c7d07d5a4b0c5c4bcde31))
* **api:** count a friction in every month it was active, not only where it was last seen ([b116dd2](https://github.com/linjiejim/greenhouse/commit/b116dd2dfc0ad8967596eb2bd8f5722398127c06))
* **api:** count only listable docs in the knowledge folder tree ([23b7fe9](https://github.com/linjiejim/greenhouse/commit/23b7fe95e52c9af2e1691dc30208f3b20e2575a6))
* **api:** cut a deck bullet longer than a slide across slides ([d038446](https://github.com/linjiejim/greenhouse/commit/d03844685d3420c508dcca2d6e1d60e2149552bc))
* **api:** cut deck tables by rendered row height, not row count ([ee4524e](https://github.com/linjiejim/greenhouse/commit/ee4524e6306206511a5d06ba32f7030e0da89723))
* **api:** fall back to users.role only for a member with no role ([e94d9d2](https://github.com/linjiejim/greenhouse/commit/e94d9d20987a17b51ff10fb6d7b9d975ce4cae82))
* **api:** give automation conversations cnv_ ids ([d86e0f5](https://github.com/linjiejim/greenhouse/commit/d86e0f59ac6c7ed2809c8d263122aead0f3e1912))
* **api:** group every active friction in the retro before taking the top ten ([8ca204e](https://github.com/linjiejim/greenhouse/commit/8ca204e7428159aebc3040a75194625c283c5561))
* **api:** idle-stop a cloud computer only if it is still idle ([645112b](https://github.com/linjiejim/greenhouse/commit/645112b4355d160357585788bd6d0a97cbb7037d))
* **api:** keep a cloud computer alive at E2B while a long command runs ([4a5c5cc](https://github.com/linjiejim/greenhouse/commit/4a5c5cc4ab791359bfe8d2dc6a92fd64c3f0a586))
* **api:** keep a gateway stream well-formed when the upstream stops mid-event ([54cc06d](https://github.com/linjiejim/greenhouse/commit/54cc06dae8738504e0cc0356fc10706ba53cdc1d))
* **api:** keep a lost cloud computer's funded block reserved ([53f46b3](https://github.com/linjiejim/greenhouse/commit/53f46b31047ad86f474206b8b170d3797c20329e))
* **api:** keep code indentation when a deck cuts a code block ([26a9f77](https://github.com/linjiejim/greenhouse/commit/26a9f7740386c902c2dd6b3f5b66dc41258a90a2))
* **api:** keep members' agent-only tools out of the in-app catalogs ([fc8e804](https://github.com/linjiejim/greenhouse/commit/fc8e8049e76fb6c047bcb99589bcbf404e69a8f3))
* **api:** keep slightly long chat titles whole instead of cutting mid-word ([a95eb66](https://github.com/linjiejim/greenhouse/commit/a95eb664bdbdb2867f3cda07212690e6176cfbe9))
* **api:** let a service without its own limit follow the team limit ([0881f6f](https://github.com/linjiejim/greenhouse/commit/0881f6f6d8a8d6ae6906e4181849ce0109dd5ad3))
* **api:** let generate_image edit images it saved to Files ([6b0fc60](https://github.com/linjiejim/greenhouse/commit/6b0fc60fbf43ff737ba8e61e59ae0e1b20ae89ab))
* **api:** let the dev client frame plugin UIs outside production ([7e249ca](https://github.com/linjiejim/greenhouse/commit/7e249ca290548a22727bb49299a54efd2501a7e2))
* **api:** list catalog tables and counts only through the guarded Tables actions ([e7b52ac](https://github.com/linjiejim/greenhouse/commit/e7b52acee0ce54d10266013f9f58144c36f9fc6b))
* **api:** never let a priced settlement skip the budget accounts ([ef7b415](https://github.com/linjiejim/greenhouse/commit/ef7b415122deb88c9831fbabb9383bc28e2d246c))
* **api:** never let a stale budget refusal stop a funded cloud computer ([5b54ae2](https://github.com/linjiejim/greenhouse/commit/5b54ae23e1c1feeb12230e0efe6f3430beff0a66))
* **api:** only a template's owner may turn it into a draft ([f2b4ada](https://github.com/linjiejim/greenhouse/commit/f2b4adaaefbedb80e2cdbcec6fc660c5791387af))
* **api:** page the retro's frictions by id so a friction recorded mid-read counts once ([789a243](https://github.com/linjiejim/greenhouse/commit/789a2434f4b91bf766120e3d2c9f723312e7c97a))
* **api:** project_mutation answers the link of what it wrote ([53b6436](https://github.com/linjiejim/greenhouse/commit/53b64366ba968917dc079feca946362a0f0f06d6))
* **api:** publish frictions in the retro as tool, kind and error class only ([f41d54e](https://github.com/linjiejim/greenhouse/commit/f41d54e30788f5e0647e3e21603bfd2233279534))
* **api:** replay a carried automation occurrence with its 1.x conversation ([766bcfc](https://github.com/linjiejim/greenhouse/commit/766bcfc13df7e1aaab60e74e304907ff51e71e1e))
* **api:** resume a half-done cloud computer block roll after a month or price change ([0483fc3](https://github.com/linjiejim/greenhouse/commit/0483fc3fe44bff9394bd6e7b586b886ccfb46395))
* **api:** run the monthly retro only after its UTC month has closed ([36a9947](https://github.com/linjiejim/greenhouse/commit/36a99478c6cccbce4df74f5849caa1a2b55252f7))
* **api:** sanitize error events inside gateway streams ([18ad614](https://github.com/linjiejim/greenhouse/commit/18ad614ea6d1d560f4fac47364d2dee520652253))
* **api:** settle an unpriced successful call at zero ([996811a](https://github.com/linjiejim/greenhouse/commit/996811a9f610961d2ec66d3eb6204599029a5158))
* **api:** take the super and team roles from users.role ([d7fe693](https://github.com/linjiejim/greenhouse/commit/d7fe693d9bd3f857944a2c7b434cfcfb2397f61d))
* **api:** tell the client when a gateway stream is cut off upstream ([77b869b](https://github.com/linjiejim/greenhouse/commit/77b869b5ce88a9f49d854f2427cbeef78a44c3f1))
* **api:** the sign-in page's provider list gets its own rate limit ([f570bd3](https://github.com/linjiejim/greenhouse/commit/f570bd306c0b9035f2af0f022a0e5bc55132d98c))
* **auth:** a stored grant drops the groups of inactive extensions instead of failing ([5c7436b](https://github.com/linjiejim/greenhouse/commit/5c7436b35ab2bf4f347efd45eb709d18bfd22a60))
* **automations:** make the Run profiles tab speak run profiles, with one tab row ([b82a3ef](https://github.com/linjiejim/greenhouse/commit/b82a3ef49d407921993017ec3d1824ea9ec078d4))
* **automations:** offer the owner's run profiles when a super edits a member's automation ([dbc2042](https://github.com/linjiejim/greenhouse/commit/dbc204235b6f5a330430faf8dc6e77faf9f94c3e))
* **automations:** say when the owner's run profiles fail to load and offer a retry ([a3c4df1](https://github.com/linjiejim/greenhouse/commit/a3c4df1a70d6bfb7fb8de76072cf86a77f069209))
* **client:** a connector return link on the phone steps back; provider words are guarded ([1b2e243](https://github.com/linjiejim/greenhouse/commit/1b2e243dd6fbe796f3cdee29c3702d1db41b0ea1))
* **client:** a place behind a sheet keeps refreshing; records and runs get real empty states ([af6e03b](https://github.com/linjiejim/greenhouse/commit/af6e03bcbebf4ab4fdc6f9d102d16ad025eac7d9))
* **client:** a plugin detail page opened without a record shows its list ([23ed663](https://github.com/linjiejim/greenhouse/commit/23ed6632f6bfe43251b95c0709667c365d2365f4))
* **client:** a station that refuses a member's error reports settles them ([3cfa54b](https://github.com/linjiejim/greenhouse/commit/3cfa54bca6182cc37ed80411b72e011d906252ee))
* **client:** accessible landmarks, dialogs, names and focus on the web ([3fc721c](https://github.com/linjiejim/greenhouse/commit/3fc721c14cb33e667484b9a352d0c319426b176b))
* **client:** activity rows prefer the action title over a bare id ([e478602](https://github.com/linjiejim/greenhouse/commit/e478602d25bf406371d637b283a2cc530248b1e7))
* **client:** an automation linked from a conversation opens as its sheet over it ([fe03729](https://github.com/linjiejim/greenhouse/commit/fe03729e8a2a1a6f61519b2a6841342d53b7605e))
* **client:** drawer Apps header lines up with its rows; phone Administration notice has a header ([5f0f462](https://github.com/linjiejim/greenhouse/commit/5f0f462b935b199632c9eb734b56065e917884b8))
* **client:** header actions on a settings page clear the window's close button ([a531ed0](https://github.com/linjiejim/greenhouse/commit/a531ed05fff6da5c405c05d0a3f70d03ec786860))
* **client:** Me shows Send feedback only when the Feedback plugin is on ([dcf768d](https://github.com/linjiejim/greenhouse/commit/dcf768d9edd8dcb29f256d902cc1ff3819fbd476))
* **client:** My Activity lists only the signed-in user's own rows ([41371f9](https://github.com/linjiejim/greenhouse/commit/41371f9e92db3984c63fcc9ea05ccfcc2cd7fba0))
* **client:** name the submitter's role in Issues & requests ([0bd707b](https://github.com/linjiejim/greenhouse/commit/0bd707bb5c720601386ca4ef7af68a9b22a7b3a8))
* **client:** native new-doc and feedback forms read field text at save ([c9a6ad3](https://github.com/linjiejim/greenhouse/commit/c9a6ad3e34c346bd025f43e33906cc151531fe97))
* **client:** native task and record forms save the text typed right before the tap ([b1257ad](https://github.com/linjiejim/greenhouse/commit/b1257ad662e8c69255d7d3d1d29282faea55e179))
* **client:** open the next screen after the keyboard and the closing sheet are down ([3c3af0f](https://github.com/linjiejim/greenhouse/commit/3c3af0f723d6060a73947b3427ab519db8c9815e))
* **client:** phone Connections says where to add your own connectors ([24a71ae](https://github.com/linjiejim/greenhouse/commit/24a71ae35f2e50ab64e7fa0e7e8953e3c6c0c1e3))
* **client:** plugin date fields read Postgres timestamp text on iOS and Android ([2a41896](https://github.com/linjiejim/greenhouse/commit/2a418964b15171c818085c5ac2c1ca4e517b340c))
* **client:** plugin lists say a row's status in words, not its raw value ([f25a8de](https://github.com/linjiejim/greenhouse/commit/f25a8de8179e76d5d11cce12ce50c89a60b556a3))
* **client:** plugin page and admin bars follow dark mode ([09d5068](https://github.com/linjiejim/greenhouse/commit/09d506815b26d0e933f45f407097d7ee76d7a8f8))
* **client:** plugin record details start below their header; the phone admin notice is titled ([55f6a61](https://github.com/linjiejim/greenhouse/commit/55f6a6165794194b503542d238c61d29c4e5a265))
* **client:** sent feedback closes without asking to discard it ([5034e2d](https://github.com/linjiejim/greenhouse/commit/5034e2da9e5a5a136e8f737bde58e1a811a63798))
* **client:** store builds carry the numeric part of a candidate version ([e9fa799](https://github.com/linjiejim/greenhouse/commit/e9fa799161f50110d1f7d44f4ea3cdba997de59a))
* **client:** Swift changes in the share extension and widget start a native build ([8ba9b4b](https://github.com/linjiejim/greenhouse/commit/8ba9b4bb75824f05899d4677991606dda8e09184))
* **client:** the Home bell shows no badge when nothing is unread ([99c5e55](https://github.com/linjiejim/greenhouse/commit/99c5e55ec38d9ba8274b6808fbd65cb8e113eec2))
* **client:** the iOS share extension reads folder and file ids as text ([752937c](https://github.com/linjiejim/greenhouse/commit/752937c6fbcd2336914d34b4a5994dfecfd908b2))
* **client:** toolbar buttons run the screen's newest press handler ([0a7561d](https://github.com/linjiejim/greenhouse/commit/0a7561d3077ccd124f4612b6c5aa779f9b1bb33e))
* **cli:** migrate-from-1x survives real 1.x data ([e11b7ac](https://github.com/linjiejim/greenhouse/commit/e11b7ac813fdb4c9a34343beef80de2eaa584335))
* **connectors:** redact OAuth tokens, guard sign-in races, recheck tool switches ([b0da675](https://github.com/linjiejim/greenhouse/commit/b0da675a6be05292046d4589b2c8338b150ddd3c))
* **connectors:** tell the model which tools are switched off; drop the misleading admin status tag ([09795ab](https://github.com/linjiejim/greenhouse/commit/09795ab8ce3381f4af943f6a9996f3b7ea525b36))
* **db:** a 2.x database is told there is no upgrade path ([8ee1f94](https://github.com/linjiejim/greenhouse/commit/8ee1f946e07ee694610df7911711bf7cdc245b13))
* **db:** carry child tasks that arrive before their parent ([957409a](https://github.com/linjiejim/greenhouse/commit/957409a3d32b90b50ae5a0b5f28ab26b1227f95d))
* **db:** lock the automation row while merging a partial notify ([5753dc6](https://github.com/linjiejim/greenhouse/commit/5753dc63b318ca64aab288420804b20f88a2d31d))
* **db:** lock the connector row before dropping credentials on delete ([f792047](https://github.com/linjiejim/greenhouse/commit/f792047e2aa24b1874afaa79f32f60dafe385521))
* **db:** prune failed notification deliveries with the other final states ([e16d0ac](https://github.com/linjiejim/greenhouse/commit/e16d0acfe9f5490b42db478de10d8ef3e96f7393))
* **desktop:** read the shared shortcut table from apps/client ([cf4f8fa](https://github.com/linjiejim/greenhouse/commit/cf4f8faa179b6077e931ed1d90dbeaa1c769e53b))
* **home:** draw the feed's loading state with divs, not table rows ([fdf246e](https://github.com/linjiejim/greenhouse/commit/fdf246e1b5f54b66770905fadedba59fadc11081))
* **memory:** the contact refusal names no tool the station may lack ([d204b92](https://github.com/linjiejim/greenhouse/commit/d204b92051a2faf93751da2a0aef156d0b5ae2f0))
* **mobile:** a conversation closed mid-send no longer reports a failed send as sent ([d831ab1](https://github.com/linjiejim/greenhouse/commit/d831ab10f619265a327599589155a55ad0e7a376))
* **mobile:** a late member lookup never clears another station's sign-in ([cf9362b](https://github.com/linjiejim/greenhouse/commit/cf9362b1928ddaea4d5ad6a59fcfcc2be19bec84))
* **mobile:** a push tapped on a cold launch opens what it points at ([794240c](https://github.com/linjiejim/greenhouse/commit/794240c3fc5ac33ebac9d352b6a82d6e8e2fd7fa))
* **mobile:** a roomier composer on an opaque bottom band ([5e6b79b](https://github.com/linjiejim/greenhouse/commit/5e6b79b3f557957f131dcabfdb8c7fde5112bb8f))
* **mobile:** a slow account read no longer overrides the text size just picked ([eed9c95](https://github.com/linjiejim/greenhouse/commit/eed9c95de9e66a67cd60fcc65251894400abcdb3))
* **mobile:** a solid band behind the conversation title ([acd54b0](https://github.com/linjiejim/greenhouse/commit/acd54b0e30fb8ecfb331e4a0dae1fb72baf0e6dd))
* **mobile:** ask again about a refused first message after a restart ([c903103](https://github.com/linjiejim/greenhouse/commit/c903103507db13f8d58a7329fec5077fbfd94e34))
* **mobile:** bind push clean-up to its station and keep the switch's target ([f9f9fe8](https://github.com/linjiejim/greenhouse/commit/f9f9fe861c658322b4f4564b524ce2eaeabf3fea))
* **mobile:** cancel a chat send that misses the connection deadline ([2cd54fc](https://github.com/linjiejim/greenhouse/commit/2cd54fce42601618c6ac53fea816bcbbbf975a96))
* **mobile:** clear every banner once marking all read is confirmed ([bcc8480](https://github.com/linjiejim/greenhouse/commit/bcc84808861f803423ad3c229ae957753b4ca281))
* **mobile:** clear only the banners of notifications known to be read ([d0610d5](https://github.com/linjiejim/greenhouse/commit/d0610d50bf43a8a232d83c5c0e5f93a6c4a8354b))
* **mobile:** count the widget's due days on the Gregorian calendar ([7031a6d](https://github.com/linjiejim/greenhouse/commit/7031a6d24eb24d5af04a2a67af6a2f2a2f7c6af7))
* **mobile:** dedup retried chat turns by client_turn_id, and drop late sends after a switch ([0e58790](https://github.com/linjiejim/greenhouse/commit/0e5879076adce9f89c1ccb7c455ecf10cb0354cf))
* **mobile:** delete a saved document once its reader loses access ([19b7460](https://github.com/linjiejim/greenhouse/commit/19b7460ddf6b76d7b8973f390995b65d8392c210))
* **mobile:** delete an offline copy on 403/404/410 even when it was never read ([db95b3e](https://github.com/linjiejim/greenhouse/commit/db95b3ee4e89959511fd287c02afe8cbabc99b80))
* **mobile:** discover sign-in providers and skip widget tasks without Projects ([b87b825](https://github.com/linjiejim/greenhouse/commit/b87b825ad25313c0ad8c8e40bba033e0655f90fa))
* **mobile:** don't hide the status bar in the sideways table ([6ede55a](https://github.com/linjiejim/greenhouse/commit/6ede55a6eb32baa43370a0276a8ab67e4759a3ef))
* **mobile:** drop a load-more answer that lands after pull-to-refresh ([bc64211](https://github.com/linjiejim/greenhouse/commit/bc64211589ec81bc90dd359d5b557c6a9e31f5c3))
* **mobile:** drop a page that lands after a refresh replaced the list ([7cf5edf](https://github.com/linjiejim/greenhouse/commit/7cf5edf7ee6d4486616f7dd8b0e243f5d89f02f7))
* **mobile:** drop document comments, gone from the 3.0 server ([d8d3848](https://github.com/linjiejim/greenhouse/commit/d8d384821010ae0e2ecc03912c541af3a44a1aea))
* **mobile:** empty the tasks widget when the station says my tasks are gone ([802d69a](https://github.com/linjiejim/greenhouse/commit/802d69a70bf2600255dd34bbeb0a878aa4d7f7ed))
* **mobile:** give connected agents the same plant as on the web ([24ac8b9](https://github.com/linjiejim/greenhouse/commit/24ac8b95adde67c4a109346845d5d3d925d49243))
* **mobile:** give the share extension the app's language and green ([6a907dc](https://github.com/linjiejim/greenhouse/commit/6a907dcfe493a1b070b61e43837652c2e0c17cc2))
* **mobile:** give the widgets the V1 green and when each document was opened ([f6c7498](https://github.com/linjiejim/greenhouse/commit/f6c749806a35fa4fc55de4d1f2ef03d524396c3f))
* **mobile:** group a saved list of my tasks for the day it is shown ([72d6459](https://github.com/linjiejim/greenhouse/commit/72d6459c16f5ac604d6c1fa02b4bc2303510e8ad))
* **mobile:** home's section title is just Recent ([954a3d4](https://github.com/linjiejim/greenhouse/commit/954a3d46a4f5922eb4170ea8ba67719040c86750))
* **mobile:** keep + on 云盘 › 表格 to make another base ([53d2b18](https://github.com/linjiejim/greenhouse/commit/53d2b1861182f01dd795d45df28568d89f9eef72))
* **mobile:** keep a Files upload on the station and account it started on ([27d9bc1](https://github.com/linjiejim/greenhouse/commit/27d9bc107f82671db4a5848dd1f29a399d8a7b38))
* **mobile:** keep not-found messages below the navigation bar ([e146fc8](https://github.com/linjiejim/greenhouse/commit/e146fc8aef4e60de40d6ef81b18d52dcf16398d8))
* **mobile:** keep parentheses in link addresses ([cb7a565](https://github.com/linjiejim/greenhouse/commit/cb7a5651e77154bb5320821fcc67af41cb5e5911))
* **mobile:** keep queued task status saves on the station that chose them ([1c2787b](https://github.com/linjiejim/greenhouse/commit/1c2787bade1915a7382d8e4af0ddac4f227abe09))
* **mobile:** keep sharing the other attachments when one is refused ([57e11ee](https://github.com/linjiejim/greenhouse/commit/57e11ee02f157c1417196ba4edd43d85a688bfc2))
* **mobile:** keep the assistant's conversation whole and in step with the server ([b0ff938](https://github.com/linjiejim/greenhouse/commit/b0ff938bfad506594f0284b9ab53585237aedd75))
* **mobile:** keep the banner and say so when opening cannot mark it read ([1abab94](https://github.com/linjiejim/greenhouse/commit/1abab9449383fbe25db5421c5af647da45f6350e))
* **mobile:** keep the chat pinned to its end through later layout changes ([f0b8c9a](https://github.com/linjiejim/greenhouse/commit/f0b8c9a2abf4bef70ab63fcc4ceb137676530a6f))
* **mobile:** keep the conversation title legible over a long reply ([b5fb788](https://github.com/linjiejim/greenhouse/commit/b5fb788eec7fdd94189d074cd43f7336f7b6b3d8))
* **mobile:** keep the details of a file opened from a link ([cf62acc](https://github.com/linjiejim/greenhouse/commit/cf62acc2f3f7104c8f255a382157c333059b3456))
* **mobile:** learn ownership on refresh and keep it in the offline copy ([78e7ff9](https://github.com/linjiejim/greenhouse/commit/78e7ff91bc7acb8809e465f5e46e15c45d8a5703))
* **mobile:** let large titles collapse on long lists ([9913ad6](https://github.com/linjiejim/greenhouse/commit/9913ad674c8defc6de1033faa636aeb84a1ee8a1))
* **mobile:** let the latest refresh error decide what an offline screen shows ([af1d8f5](https://github.com/linjiejim/greenhouse/commit/af1d8f52ece6d55da7ae6820c62fa002e543e11f))
* **mobile:** list recently opened documents when the shelf cannot load ([8a6676b](https://github.com/linjiejim/greenhouse/commit/8a6676b0d81f63962b9e506ddedbfda0a8fa13d3))
* **mobile:** no discard prompt after creating a document ([affee74](https://github.com/linjiejim/greenhouse/commit/affee74740a70a4e99bf8a20ecd44a8663b4b361))
* **mobile:** offer a share retry only for files that can still succeed ([b086a17](https://github.com/linjiejim/greenhouse/commit/b086a17e206e564e11dcdf6730d6ce4ffa84b1e6))
* **mobile:** offline sends queue at once and go when the station answers again ([a073c83](https://github.com/linjiejim/greenhouse/commit/a073c83ca852078119dc2d7c9ee0ab7ad2162913))
* **mobile:** open a doc link that names only a slug ([1ffa616](https://github.com/linjiejim/greenhouse/commit/1ffa616ce787010789b672bdfac84d7a7fa59d3b))
* **mobile:** open a widget item only on its station, also on a cold launch ([cdca789](https://github.com/linjiejim/greenhouse/commit/cdca7892b9554eaafacdf05b1511ad43e2369b17))
* **mobile:** open a widget item over home when a sheet is showing ([c44df11](https://github.com/linjiejim/greenhouse/commit/c44df111e2955b12d1e479e63cf3548270020dfa))
* **mobile:** open the camera for photos only ([47366f1](https://github.com/linjiejim/greenhouse/commit/47366f1094dbcf1439293fde884cb64b68d16a77))
* **mobile:** padded reply cards above the words, agent plants on writes ([4218b92](https://github.com/linjiejim/greenhouse/commit/4218b9234c7fc43d678bd53633c8a52055fc3ea4))
* **mobile:** page on after a refresh that replaces the offline copy ([9c31991](https://github.com/linjiejim/greenhouse/commit/9c31991d9f1d7fe007e0be595758f286b7d4c10f))
* **mobile:** page the assistant's conversation list past 50 ([22e9661](https://github.com/linjiejim/greenhouse/commit/22e9661cd0fe2e59c28c64a8d884ddd94721fd5b))
* **mobile:** read a saved message's tool steps from the 3.0 parts object ([3de3be0](https://github.com/linjiejim/greenhouse/commit/3de3be08df9273a05e304710d7d38b6e49c5a12c))
* **mobile:** read every page of a knowledge shelf ([667b7a3](https://github.com/linjiejim/greenhouse/commit/667b7a38cc9c640ff0b18e56142a12280d6e2925))
* **mobile:** read-only until ownership is known; lock agent while making ([43539a3](https://github.com/linjiejim/greenhouse/commit/43539a34430b758b935f88ff2d9bb0298ce6e55d))
* **mobile:** readable status tiles in dark mode ([f249fa4](https://github.com/linjiejim/greenhouse/commit/f249fa4a10e84a3aa648f5a9aa94f158c1aef3fb))
* **mobile:** render emphasis in user bubbles instead of literal ** ([714dc21](https://github.com/linjiejim/greenhouse/commit/714dc21213ff41a2273fbd10f36255c9e3f4bf0c))
* **mobile:** retry a first message when starting its conversation is briefly refused ([3640a72](https://github.com/linjiejim/greenhouse/commit/3640a722e6e83f4bbcfb753012a29b98354155ee))
* **mobile:** retry only the share uploads that did not finish ([f819ec8](https://github.com/linjiejim/greenhouse/commit/f819ec84a54df55949d44d03381a3d5759941105))
* **mobile:** save a task's status one change at a time ([32ea4d6](https://github.com/linjiejim/greenhouse/commit/32ea4d6a8cc7ac333b045947f06571836ee798c6))
* **mobile:** say "Used 1 tool", not "Used 1 tools" ([f3c724f](https://github.com/linjiejim/greenhouse/commit/f3c724f6de13b42431482228f38db5cb1d074be2))
* **mobile:** search fields keep words as typed ([3bc515d](https://github.com/linjiejim/greenhouse/commit/3bc515dc36cae880e6b8bfd292ddef52d3702d7d))
* **mobile:** send each queued message once and never lose one ([57d806c](https://github.com/linjiejim/greenhouse/commit/57d806c8a991ba337118c8887f5ca68dfc6cecfa))
* **mobile:** settle races and read-only gaps found in review ([464dabf](https://github.com/linjiejim/greenhouse/commit/464dabfe7a18782cdda4334e01c5c56114eb8bf6))
* **mobile:** sheets scroll as their root, sheet actions show, and the mic has its permission ([f8445f5](https://github.com/linjiejim/greenhouse/commit/f8445f589d8b1e96b2f2b6fb1751178ef54d97b2))
* **mobile:** show a record before people's names arrive ([90f3b45](https://github.com/linjiejim/greenhouse/commit/90f3b45b96a549d6d66cf6a37921376d925fd52f))
* **mobile:** show a text file's contents in the file sheet ([88bf8b3](https://github.com/linjiejim/greenhouse/commit/88bf8b312cc13ac30c1b94e3a0c8c807d4dd8967))
* **mobile:** show My Agents' spend and keys failures with a retry ([6031038](https://github.com/linjiejim/greenhouse/commit/603103875ef332c8e9df826560d48fdb8470657e))
* **mobile:** show people's names on records read offline ([baea340](https://github.com/linjiejim/greenhouse/commit/baea3409cbc6b1d7b474229b0d63a401ddc689f2))
* **mobile:** Sprouty makes room when it talks; a reply stays followed ([2528eb2](https://github.com/linjiejim/greenhouse/commit/2528eb2ad4b2d06d120c45e5ec7c2fea198ef6ff))
* **mobile:** stop jumping to the end when older messages load ([19ae802](https://github.com/linjiejim/greenhouse/commit/19ae80251b0a87b8856f2d8097941b2f5e9ebe8f))
* **mobile:** switching pushes off wins over a registration in flight ([55c1323](https://github.com/linjiejim/greenhouse/commit/55c1323722d4093edc96d9627b7512b01e32d4a8))
* **mobile:** take a reloaded task status as the rollback baseline ([e7b16a1](https://github.com/linjiejim/greenhouse/commit/e7b16a130943305fd17288e4eb26205d8abc7254))
* **mobile:** take only a newer assistant message as the saved reply ([f2fc175](https://github.com/linjiejim/greenhouse/commit/f2fc175984c87a430ecc3a324f979bf4487a53ba))
* **mobile:** the automation sheet's prompt and switch sit in cards ([ad6081b](https://github.com/linjiejim/greenhouse/commit/ad6081b09b7f5138f94178e1cdf6b5c163d1dc48))
* **mobile:** the composer keeps its placeholder after a theme switch ([995234f](https://github.com/linjiejim/greenhouse/commit/995234f8f0695749afbc3075a960b762f2e56557))
* **mobile:** the edge swipe on a pushed page goes back, not to the sidebar ([0adb205](https://github.com/linjiejim/greenhouse/commit/0adb20584d8468802c55ebe6dcaaebadc0ac5fda))
* **mobile:** the place stays lit while the sidebar shows under it ([ac28673](https://github.com/linjiejim/greenhouse/commit/ac28673a8dc22dec63a2bc474c0ba19c905f32c9))
* **mobile:** the sidebar button puts the keyboard away first ([34c927a](https://github.com/linjiejim/greenhouse/commit/34c927a7be03cbd421a785a52a5fe3cfa4ebe13f))
* **mobile:** the sideways table fills the whole screen ([4c2430a](https://github.com/linjiejim/greenhouse/commit/4c2430abc8e1ad261b75705217dd45c365a5042a))
* **mobile:** the sideways table measures its own safe area ([5150f4b](https://github.com/linjiejim/greenhouse/commit/5150f4b57c0459d00839c56697a4b7f6cd434ada))
* **mobile:** tint the segmented control's menu with the V1 accent ([b896a58](https://github.com/linjiejim/greenhouse/commit/b896a5879f4330c568f2c8e1d8af1398568ea3a1))
* **mobile:** treat object ids as text ([b1f3f4c](https://github.com/linjiejim/greenhouse/commit/b1f3f4ca5cfcf85f397809e87df6ac31e59b3863))
* **mobile:** treat the latest page as the truth and recognise a regenerated reply ([ac8e836](https://github.com/linjiejim/greenhouse/commit/ac8e836ed21d0de7e3da1b92891da79283d10fde))
* **mobile:** universal client polish — documents, grid, board, entity lists ([998b313](https://github.com/linjiejim/greenhouse/commit/998b3133c007bcd3137ee1f2d92d712235df6624))
* **mobile:** web radios, grid rows and chip clicks are reachable ([be5a270](https://github.com/linjiejim/greenhouse/commit/be5a270416a85e3c25916acb4c47da9196ab3253))
* **mobile:** work out the widget's due buckets for each day it shows ([7c98961](https://github.com/linjiejim/greenhouse/commit/7c989617e39f90e038097117874a2ade737d6af2))
* **notifications:** point runtime notices at the Activity log, in the reader's language ([25fdb12](https://github.com/linjiejim/greenhouse/commit/25fdb128be66386642760a015ddb2f464349cf34))
* **plugins:** data entity writes accept only fields the member may write ([cf8631d](https://github.com/linjiejim/greenhouse/commit/cf8631d16bc6d90dbff8709491abb0021def58b8))
* **plugins:** station manifest checks each data source's own feature flag ([17a313a](https://github.com/linjiejim/greenhouse/commit/17a313a3ef0bcf72d65280572550b6325db8d46d))
* **refs:** name a doc by slug when its link carries no id ([9b68335](https://github.com/linjiejim/greenhouse/commit/9b68335097facb46d37bbcbb0c92914fec740004))
* **refs:** resolve the doc slug links the address bar shows ([dc5c409](https://github.com/linjiejim/greenhouse/commit/dc5c4098ce608c98bba5d7237737779c616330d4))
* say when the data catalog cut a base's tables, and keep the real total ([aeb8717](https://github.com/linjiejim/greenhouse/commit/aeb8717f9e9475bef67eee6f531d8a918883f43d))
* **skillhub:** call the My prompts tab's items prompts, not tasks ([b4abdaa](https://github.com/linjiejim/greenhouse/commit/b4abdaa15b423957ebf619224acb1eb323f37675))
* **tables:** batch relation labels per table and refresh them on edits ([293efa2](https://github.com/linjiejim/greenhouse/commit/293efa276b1cd8315ca95f401f50fe5053db14e0))
* **ui:** keep delete buttons readable in dark mode ([411c19b](https://github.com/linjiejim/greenhouse/commit/411c19b187f2b7ab557754d82cf4457a5e8f8d4e))
* **web:** drop the Codex gateway config that current Codex rejects ([f37cbb6](https://github.com/linjiejim/greenhouse/commit/f37cbb60f76eaa25f98cbe39e411b0b00d14465d))
* **web:** fit the sidebar wordmark beside the bell, keep Home's recent list on desktop ([32d8e40](https://github.com/linjiejim/greenhouse/commit/32d8e40824b5478b8adc3bdf9f9169a5a9003fb8))
* **web:** keep a cleared format selection cleared in the template form ([e1191ce](https://github.com/linjiejim/greenhouse/commit/e1191ce60521095aaec5a399474dee2bdd91024e))
* **web:** keep an incompatible web extension out of every surface ([1462c6c](https://github.com/linjiejim/greenhouse/commit/1462c6ca50edabc7ec0fd26e7c82534f96461be6))
* **web:** keep block buttons inert while a reply is running ([ffd1af8](https://github.com/linjiejim/greenhouse/commit/ffd1af870de958d7627321c5022c22096fd29302))
* **web:** keep resolved chip titles private to the member who asked ([676bd0a](https://github.com/linjiejim/greenhouse/commit/676bd0a01c7cea367045282f7729f5d0aaf441b9))
* **web:** keep the budget table's header columns apart ([fb2d1f2](https://github.com/linjiejim/greenhouse/commit/fb2d1f23f2f5fc0a3a963fb2f9490f0d422bb776))
* **web:** one tab row and one rhythm across the new module pages ([082a59b](https://github.com/linjiejim/greenhouse/commit/082a59b189bc3e0cb019f5d2efda0f01c1f4a712))
* **web:** page the member-limit list instead of returning every row ([9f42193](https://github.com/linjiejim/greenhouse/commit/9f421930d237dccca19eec28f8e46566273e51fc))
* **web:** reload member limits when the month or a budget changes ([2fb4e1a](https://github.com/linjiejim/greenhouse/commit/2fb4e1ab8e1fd0e637b9249b526f897604693de2))
* **web:** resolve retired hashes in the router so the sidebar lights where you landed ([608eac3](https://github.com/linjiejim/greenhouse/commit/608eac30ab7f773133d988edbba09772372d93e9))
* **web:** retire leftover copy for removed features and align wording with the agent hub ([332ad86](https://github.com/linjiejim/greenhouse/commit/332ad861abb87f8b0df902a0faa2c604cb44d8fb))
* **web:** say 团队 Agent 中台 in the Chinese sidebar tagline ([42b2cb7](https://github.com/linjiejim/greenhouse/commit/42b2cb76b6d5c71668f41041f9e0151f002c0424))
* **web:** show a boolean switch's effective value, not just its override ([d9d3368](https://github.com/linjiejim/greenhouse/commit/d9d3368dd9dc4327d3655deab2078659111cd61e))
* **web:** show the linked record's name in Tables relation cells ([9d57c65](https://github.com/linjiejim/greenhouse/commit/9d57c65f00a26379c6cfe7cfa0c01a66fb69fe8c))
* **web:** tables catalog route is not a base id ([8fdacc2](https://github.com/linjiejim/greenhouse/commit/8fdacc2bd75798316779ccd867643a97253f218b))


### Changed

* **api:** automations take notify as one object; the flat notify_* aliases were classic-only ([6f16fa6](https://github.com/linjiejim/greenhouse/commit/6f16fa68c799bc395731cac1ce13237406069172))
* **api:** drop the boot-time settle of retired run kinds ([8bf23c1](https://github.com/linjiejim/greenhouse/commit/8bf23c173762b645027b7ad9430bef2ca9d0ab3d))
* **api:** serve the hosted client precompressed ([6f58364](https://github.com/linjiejim/greenhouse/commit/6f58364c79160d2dbc94b709cae2b2a9ca203673))
* apps/client and one plugin host directory ([bd924ae](https://github.com/linjiejim/greenhouse/commit/bd924ae6a3d00a50566472afc867de8ea347fc70))
* **auth:** remove user groups ([8f170e3](https://github.com/linjiejim/greenhouse/commit/8f170e30e082bd24e69556ea74b2af4341267063))
* **client:** breakpoints come from wide-model constants ([8e54edd](https://github.com/linjiejim/greenhouse/commit/8e54edd1d9f6c47bc68a60ef8695f86fe87004fe))
* **client:** import lucide icons one file each ([c554984](https://github.com/linjiejim/greenhouse/commit/c5549843e2850b43f1ebb4ad807b373ec1f61174))
* **client:** one dialog, menu, button and form kit; design rules rewritten ([204010e](https://github.com/linjiejim/greenhouse/commit/204010e12f0bea62a5e23f3e2d5fdbdc980e9fa1))
* **client:** the browser loads the document editor, admin sections and diagram font on demand ([646dac0](https://github.com/linjiejim/greenhouse/commit/646dac0bfba6d5cec21caa68ea327355e2704b19))
* delete exports no caller reads ([5d9b564](https://github.com/linjiejim/greenhouse/commit/5d9b564765e260789607a7fe7cd02bbbeb90d9d3))
* drop compat kept only for the classic client and retired features ([07592cb](https://github.com/linjiejim/greenhouse/commit/07592cb2075e653c6246b7bc8aaaf455256b977e))
* **knowledge:** remove document comments and backlinks ([0a8a5be](https://github.com/linjiejim/greenhouse/commit/0a8a5bedfc2044d82ca6ae482353c1c9294a78c0))
* **mobile:** one row-position helper, Section/Row names and a scalable type ramp ([0873986](https://github.com/linjiejim/greenhouse/commit/0873986c06f52a0d62f4d33afc73f8b91ebb8f7e))
* **platform-kernel:** drop the never-populated per-user overrides ([265f0b4](https://github.com/linjiejim/greenhouse/commit/265f0b42b63259acb81f48f32efca7f1f1534c1d))
* release 4.0.0-rc.2 ([5b37c98](https://github.com/linjiejim/greenhouse/commit/5b37c98f699a6736c62df6ab2234a87212a12514))
* **release:** 3.0.0 ([99b5dcb](https://github.com/linjiejim/greenhouse/commit/99b5dcbed88d8fe7ba8a15133a14fd74c44fa328))
* **tables:** remove forms, dashboards, in-table automations and notifications ([712f037](https://github.com/linjiejim/greenhouse/commit/712f0372d163b22659cb5b09ea3c756746330230))
* **web:** call the file cabinet 云盘 instead of 档案库 ([82c038d](https://github.com/linjiejim/greenhouse/commit/82c038d2fbbc597e860ea7892d999aff21f2e904))

## 4.0.0-rc.1 (2026-10-27)

Release candidate for testing; publication is a maintainer step described in [RELEASING.md](RELEASING.md).
Read [Upgrading to 4.0](docs/upgrading-to-4.0.md) before upgrading.

### Breaking changes

- Greenhouse now separates a governance core from twelve official plugins. Knowledge, Tables,
  Skills, Feedback and Memory are enabled by default. Projects, Reports, Email, WeCom, Feishu,
  Computer and Retro are compiled but disabled by default. Credentials do not enable a plugin.
- Disabling a plugin removes its routes, tools, settings, navigation, MCP groups and adapters.
  Data and applied migrations remain. Retro requires Knowledge; saved prompts remain core.
- The classic web app is removed. The universal client (`apps/client`, renamed from
  `apps/mobile`) is the only web client: the API serves it at `/`. `/classic` and browser `#/…`
  addresses are not mapped: old bookmarks open Home, and the run sheet no longer links to a web
  run log. Server-made links (including automation and Feishu conversation links) use client
  routes. `clients.web` in `greenhouse.config.ts` is now a boot error.
- Plugins are SDK 2 packages with an API half and a pure manifest; client UI comes from manifest
  pages, navigation and an optional static `ui/`. `plugins:sync` refuses SDK 1 and a `web` half,
  and a missing `sdk` or `core` declaration refuses activation. Plugin production code may import
  only the API kit and the permitted shared exports; core cannot import plugin implementations.
- SDK 2 entity writes reject unknown, immutable or member-forbidden fields atomically, including
  for super. Ids, storage timestamps and internal/confidential/restricted fields are never caller
  input. Owner/member input requires explicit writable metadata; creates stamp effective ownership.
- Server client API level is 4 and every client requires it: 3.x apps must update to use a 4.0
  station, and 4.0 clients ask a 3.x station to update. `GET /api/extensions` serves manifest v2
  only (member-filtered plugins/surfaces/entities); the v1 `extensions` and `entityKinds` fields
  and plugin page `fallback_url` are removed.
- 4.0 starts a new core migration chain (`packages/db/migrations/0000_v4_baseline.sql`, 49 core
  tables). Fresh installs no longer create plugin tables; each plugin creates its own when
  enabled. 3.x databases upgrade in place and the API refuses a 3.x database until
  `pnpm db:migrate` has bridged it. 1.x and 2.x databases are refused; `migrate-from-1x` is removed.
  Core migration `0001_drop_legacy_data_shapes` rewrites data shapes 1.x wrote and 3.x carried
  (numeric task ids, flat `notify_*` snapshots, JSON-text payloads and lists, `session_history` in
  custom Agents), and the readers that tolerated them are gone.
- Environment aliases `APP_BASE_URL`, `SYNC_WECOM_WEBHOOK_URL`, `PORT` (OAuth issuer) and
  `SILICONFLOW_API_KEY` (doctor) are ignored. The agent proxy and MCP refuse retired tool names
  (`session_history`, `team_knowledge`, …); connector catalog files use `"mode": "key"` instead of
  `per_user`; avatar writers no longer dual-write the pre-plant `color` and `faceStyle` keys.
- `TASK_CENTER_ENABLED` is removed: `/api/runtime` is always on and `/health` drops
  `surfaces.task_center`; `RUNTIME_APPROVAL_INBOX_ENABLED` alone switches the Approval Inbox.
- `POST /api/chat` no longer continues a stored transcript without a new message: a session turn
  sends `messages` or `regenerate_assistant_message_id`, and a live reply is resumed through
  `GET /api/chat/runs/:sessionId/stream`.
- `GET /api/platform/apps`, `GET /api/platform/me/permissions`, `GET /api/data-catalog` and
  `GET /api/admin/operations/cost-value` are removed; the MCP `data_catalog` tool remains.
- `/api/ws` no longer sends supers online-presence events (`presence:*`).
- Chat turns no longer take page context or browser Client Actions: `ambient_context`,
  `client_actions`, `client_action_scope_id`, `POST /api/client-actions/tool-result`, the
  `local-tool-request` event and `@greenhouse/types/agent-context` are removed.
- Plugin frontends receive `--gh-*` theme variables only; the classic `--t-*` names and the
  classic web stylesheet `@greenhouse/ui/tokens/tokens.css` are removed.
- Core migration `0003_canonical_profile_ids` rewrites stored retired profile ids (`team`,
  `default`, the retired presets, `eval-judge` → `sprouty`; `local-dev`/`local-pi` → `desktop`)
  and makes `sprouty` the column default. Readers take stored ids as they are; only request
  edges (`/api/chat`, `/api/sessions`, `/api/agent`, automations, custom-Agent base) still map
  the old ids.
- Core migration `0004_retired_tool_aliases` rewrites retired plugin tool ids in custom Agents and
  saved prompts (`team_knowledge`/`personal_knowledge` → `knowledge_query`, `project_manager` →
  `project_query` + `project_mutation`, `example_notes_legacy` → `example_notes_query`), and the
  `retiredToolAliases` plugin seam that expanded them at run time is removed.
- `GET /api/sessions` caps every page at 200 and no longer accepts `include_eval`.
  `GET /api/feishu/login-available` (use `/api/auth/providers`), `GET /api/profiles/custom/:id/versions`,
  the custom Agent `change_log` field and the team activity feed's plain ISO `before` are removed. Automations
  take delivery only as the `notify` object; the flat `notify_*` fields are ignored.

### Upgrading from 3.x

Back up, choose the plugins to enable (several formerly built-in modules are now off), run
`pnpm db:migrate` (Compose runs its `migrate` service first) and restart. The step-by-step
procedure, rollback, removed screens, old addresses and the SDK 1 to SDK 2 port are in
[docs/upgrading-to-4.0.md](docs/upgrading-to-4.0.md).

### Added

- Configuration-driven plugin packages under `plugins/<id>`, generated static registrations
  via `plugins:sync`, package import guards, zero-package `test:core`, plugin CLI list/status/drop
  and a read-only Admin › Plugins section.
- SDK 2 `dataSources`: kernel app/actions/policies, governed query/mutation tools, CRUD REST,
  catalog/search/export/peek and declarative entity pages from one definition.
- Reach-filtered Agent prompt fragments, resources and prompts; five isolated asynchronous
  observations; migration-locked persistent onInstall. Notification/identity/channel, retention,
  pricing, catalog/entity/discriminator and other contribution registries serve official and
  private plugins alike.
- Universal client on web/iOS/Android: wide-screen rail with a More flyout for apps, secondary
  column, inspectors, web sign-in, command palette, notifications, documents, grids, boards,
  manifest pages and fixed-size centered dialogs.
- The Admin place (`/admin`, super only): users and permissions, activity log with CSV export,
  usage, services & pricing, team context, branding with a scoped preview, runtime config, MCP
  access, team connectors and plugins, plus plugin sections (Issues & requests, Retro, Computer)
  declared as manifest pages with `parent: 'administration'`.
- Client entry pages for account activation, MCP OAuth consent, connector and identity-provider
  returns, account bindings and Feishu sign-in; server links come from
  `@greenhouse/types/client-routes` with secrets in the fragment, and old `#/…` links are mapped.
- The automation editor and custom agents in the Automations place; the station manifest says
  which notification transports accept a webhook.
- Member names for plugin `user` fields (`POST /api/people/resolve`).
- Local macOS Tauri 2 shell bundling the universal client, Keychain station sessions, menus,
  notifications, Dock badge, Quick ask, deep links and opt-in signed updater wiring.
- Manifest renderers for entity-list/detail, settings-form and trusted embed pages. Ten-minute
  member/plugin tokens, renewal, theme/branding, locale, navigation, titles and editable
  assistant drafts. `@greenhouse/ui-tokens` supplies generated themes and `connectGreenhouse`;
  Example includes a buildable static UI using it.
- Client browser suite `pnpm test:e2e:client` (`tests/client-e2e`) with env-overridable ports and
  database.

### Changed

- Knowledge, Tables, Projects, Skills, Memory, Feedback, Reports, Computer, Email, WeCom,
  Feishu and Retro own their implementations under plugins, including relevant schema/services,
  routes/tools, copy, migrations and tests. Core schema owns 49 tables; official plugins own 24,
  created by each plugin's own migration lane when it is enabled.
- The plugin host lives in `apps/api/src/plugin-host` (formerly `extensions/` and `platform/`);
  OAuth 2.1 helpers moved to `apps/api/src/agent-access/oauth.ts`. Scripts are `client:*`
  (formerly `mobile:*`); `pnpm dev` runs the API with Expo web; Docker and CI build only the
  universal client.
- Conversation sharing is deployment-controlled by `conversations.sharing` (default true).
  Core Markdown team context works without Knowledge. Optional integration controls and delivery
  adapters come from active plugins; WeCom remains binding-only, Feishu supports login/binding.
- Desktop CORS and framing allow exactly tauri://localhost; counters and paid usage attribute
  desktop requests.
- One product version is synchronized across all app/package/plugin metadata, Expo config and
  desktop Cargo/Tauri files. Release automation is configured for rc increments and documented
  stable promotion.

### Removed

- The classic web app (`apps/web`), SDK 1 and in-tree extension overlays, every plugin `web/`
  half, `@greenhouse/web/extension-kit`, `packages/contract`, the `@greenhouse/crud` React client,
  `tests/e2e-ui`, `tests/web`, `playwright.config.ts`, `pnpm web:*` and `pnpm test:e2e:ui`.
- The 1.x carry path (`migrate-from-1x`, its fixtures and `archive-1x`) and the boot-time settle
  of retired run kinds.
- `scripts/skillhub-sync.mjs`, `scripts/capture-screens.mjs`, `scripts/clean-web-output.mjs`,
  `scripts/apply-ext-migrations.mjs`, the `platform create-app` CLI and its scaffold.
- Classic-only screens without a client equivalent yet: saved-prompt management and the `/`
  picker, the member activity log page, member editing of email accounts, memories and the cloud
  computer, skill upload and report-template editing, the agent-connection wizard, adding personal
  connectors, member gateway-key creation, the knowledge share dialog, the project members panel
  and Tables field editing/recycle bin/data catalog/audit. Their APIs and tools remain; see the
  upgrade guide for alternatives.

extension-kit: expose the DB primitives, shared CRUD/form/editor/preview helpers and governance
facades needed by official plugins; add data entity/context types, scoped CRUD, recordWrite,
notify, readable-field projection and observation types. Remove `WidgetRecipe`,
`defineExtension.workbenchRecipes` and the tool surface `workbench` flag. Kit exports remain
snapshot-locked; optional kernel `writable` metadata enforces declared SDK 2 writes.
`resolveEntityPolicy` takes role policies only: the never-populated per-user capability and
entity overrides are removed from the kernel and the platform snapshots.
`defineExtension.retiredToolAliases` is removed: core migration `0004_retired_tool_aliases`
rewrote the stored ids it expanded.

### Fixed

- Data entity field checks agree across REST, agent/MCP tools, direct runtime and member manifests;
  persisted broad grants cannot bypass declaration-level immutability or owner stamping.
- The station manifest checks each data source's own feature flag.
- Client forms submit changed writable fields only; list refresh retains loaded rows/totals/paging
  after saves and discards stale query/identity replies.
- Browser controls expose usable ARIA state and keyboard/click behavior; enum chips do not steal
  row activation, and wide inspectors keep the visible main route accessible.

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

## [0.1.0]

- Initial release.
